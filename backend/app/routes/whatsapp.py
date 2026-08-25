"""
Cada usuário só vê/responde as conversas ATRIBUÍDAS A ELE. Uma conversa
nova (sem atribuição ainda) fica numa "fila" visível a todos até alguém
assumir ("Assumir") ou ser encaminhada por um dono/admin ("Encaminhar").
O administrador vê e age em TUDO — inclusive olhar a conversa de outro
usuário em modo supervisão, o que deliberadamente NÃO zera o contador de
não lidas dele (só o próprio dono zera, ao abrir a conversa que é dele).
"""
import csv
import io
import datetime
import os
import re
import secrets

from flask import Blueprint, Response, g, jsonify, request, send_from_directory
from werkzeug.utils import secure_filename

from .. import transcricao, whatsapp_service
from ..context import ApiError, ForbiddenError, get_current_user, get_db, requires_admin, requires_auth

bp = Blueprint("whatsapp", __name__, url_prefix="/api/v1/whatsapp")

# ============================================================
# QUEM SÓ TEM CHAT INTERNO NÃO PASSA DAQUI
#
# A trava é no blueprint inteiro, não rota a rota, por um motivo
# prático: rota nova nasce protegida por padrão. Esconder o menu não
# bastaria — sem isso, bastava digitar o endereço (ou chamar a API) pra
# ler o atendimento dos clientes.
#
# A lista abaixo é a exceção: coisas que moram neste arquivo mas servem
# aos DOIS lados do sistema. Lembretes, agendamentos e etiquetas são
# compartilhados com o chat interno (e cada consulta desses já filtra
# pelo próprio usuário). Anexos idem: o chat interno guarda e serve os
# arquivos dele por esta mesma pasta. Logo da empresa aparece na tela de
# login, antes de existir sessão. Webhook é a Evolution API chamando de
# fora, sem usuário nenhum.
# ============================================================
ENDPOINTS_LIBERADOS_SEM_CONVERSAS = {
    "listar_tags", "criar_tag", "editar_tag", "excluir_tag", "contar_por_tag",
    "listar_lembretes", "concluir_lembrete", "adiar_lembrete",
    "listar_todas_agendadas", "cancelar_agendada", "editar_agendada",
    "baixar_anexo", "baixar_logo",
    "listar_emojis", "salvar_emoji", "excluir_emoji",
    "listar_figurinhas", "salvar_figurinha", "excluir_figurinha",
    "webhook", "status_resumido",
}


@bp.before_request
def _barrar_sem_acesso_a_conversas():
    endpoint = (request.endpoint or "").rsplit(".", 1)[-1]
    if endpoint in ENDPOINTS_LIBERADOS_SEM_CONVERSAS:
        return None
    # Este gancho roda ANTES do @requires_auth da rota, então g.usuario_atual
    # ainda não existe: é preciso resolver a sessão aqui. Se não houver
    # sessão válida, sai calado — quem recusa (com 401) é o @requires_auth,
    # que roda logo em seguida.
    try:
        usuario = get_current_user()
    except ApiError:
        return None
    if usuario["admin"]:
        return None
    liberado = "acesso_conversas" not in usuario.keys() or usuario["acesso_conversas"]
    if liberado:
        return None
    raise ForbiddenError("Seu acesso é só ao chat interno. Peça a um administrador para liberar as conversas.")


PASTA_UPLOADS = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "data", "uploads")
MAX_ANEXO_MB = 35
EXTENSOES_TIPO = {
    "imagem": {"jpg", "jpeg", "png", "gif", "webp"},
    "video": {"mp4", "mov", "avi", "webm", "mkv"},
    "audio": {"mp3", "ogg", "wav", "m4a", "opus"},
}


def _classificar_tipo(nome_arquivo: str) -> str:
    ext = nome_arquivo.rsplit(".", 1)[-1].lower() if "." in nome_arquivo else ""
    for tipo, extensoes in EXTENSOES_TIPO.items():
        if ext in extensoes:
            return tipo
    return "documento"


def _now_iso():
    return whatsapp_service._now_iso()


# ============================================================
# CONFIGURAÇÃO E CONEXÃO — admin
# ============================================================
@bp.get("/configuracao")
@requires_admin
def obter_configuracao():
    conn = get_db()
    return jsonify(whatsapp_service.config_publica(whatsapp_service.obter_configuracao(conn, g.empresa_id)))


@bp.put("/configuracao")
@requires_admin
def atualizar_configuracao():
    usuario = g.usuario_atual
    dados = request.get_json(silent=True) or {}
    conn = get_db()
    nova = whatsapp_service.salvar_configuracao(conn, dados, usuario["id"], g.empresa_id)
    return jsonify(whatsapp_service.config_publica(nova))


@bp.get("/webhook-url")
@requires_admin
def webhook_url():
    conn = get_db()
    config = whatsapp_service.obter_configuracao(conn, g.empresa_id)
    if not config.get("webhook_segredo"):
        raise ApiError("Ative e salve a configuração do WhatsApp primeiro (o segredo é gerado automaticamente).", status=400)
    return jsonify({"url": f"{request.host_url.rstrip('/')}/api/v1/whatsapp/webhook/{config['webhook_segredo']}"})


@bp.post("/conectar")
@requires_admin
def conectar():
    dados = request.get_json(silent=True) or {}
    numero = (dados.get("numero") or "").strip() or None
    if numero:
        numero = re.sub(r"\D", "", numero)
        # Aceita tanto com quanto sem o 55 (DDI Brasil) — o cliente não
        # precisa adivinhar o formato certo. NÃO usa normalizar_telefone
        # (essa função insere o "9" do celular) porque aqui pode ser fixo
        # (8 dígitos, sem 9) ou celular (9 dígitos) depois do DDD; só o
        # DDI é opcional/normalizado, o resto fica exatamente como digitado.
        if len(numero) in (10, 11) and not numero.startswith("55"):
            numero = "55" + numero
    conn = get_db()
    # Descobre sozinho por onde a Evolution API deve devolver as
    # mensagens.
    #
    # O padrão antigo (host.docker.internal) só funciona no Docker de
    # Windows/Mac; no Linux o container não alcança esse nome, e o
    # resultado era o pior tipo de falha: mandar mensagem funcionava,
    # receber não — sem erro nenhum na tela, só silêncio.
    #
    # O endereço certo é justamente aquele pelo qual o administrador
    # está acessando agora (o domínio público), então é ele que fica
    # gravado quando ninguém configurou nada ainda.
    if not (whatsapp_service.obter_configuracao(conn, g.empresa_id).get("webhook_base_url") or "").strip():
        base = request.host_url.rstrip("/")
        if base.startswith("https://"):
            conn.execute(
                "UPDATE configuracoes_whatsapp SET webhook_base_url = ? WHERE empresa_id = ?",
                (base, g.empresa_id),
            )
    config = whatsapp_service.obter_configuracao(conn, g.empresa_id)
    resultado = whatsapp_service.conectar_instancia(conn, config, numero=numero)
    return jsonify(resultado)


@bp.get("/status")
@requires_admin
def status():
    conn = get_db()
    config = whatsapp_service.obter_configuracao(conn, g.empresa_id)
    if not config.get("evolution_url"):
        return jsonify(whatsapp_service.config_publica(config))
    whatsapp_service.consultar_status(conn, config)
    return jsonify(whatsapp_service.config_publica(whatsapp_service.obter_configuracao(conn, g.empresa_id)))


@bp.get("/status-resumido")
@requires_auth
def status_resumido():
    """Versão enxuta do status, liberada pra qualquer usuário logado (não
    só admin) — só o que dá pra mostrar uma bolinha verde/vermelha na
    barra lateral, sem expor URL/chave da Evolution API. Não força uma
    consulta nova à Evolution API (isso é caro e só o admin faz, na tela
    de Configuração/polling dela) — só lê o último valor já sabido."""
    conn = get_db()
    config = whatsapp_service.obter_configuracao(conn, g.empresa_id)
    return jsonify({"status_conexao": config.get("status_conexao")})


@bp.post("/desconectar")
@requires_admin
def desconectar():
    dados = request.get_json(silent=True) or {}
    limpeza = dados.get("limpeza") or "manter"
    if limpeza not in ("manter", "ocultar", "apagar"):
        raise ApiError("Opção de limpeza inválida.", status=400)

    conn = get_db()
    config = whatsapp_service.obter_configuracao(conn, g.empresa_id)
    whatsapp_service.desconectar_instancia(conn, config)

    if limpeza == "ocultar":
        whatsapp_service.ocultar_todas_conversas(conn, g.empresa_id)
    elif limpeza == "apagar":
        # Pega os arquivos ANTES de apagar as linhas do banco (a pasta de
        # uploads é compartilhada entre empresas — só pode remover os
        # arquivos DESTA empresa, nunca a pasta inteira).
        midias = conn.execute(
            """
            SELECT m.midia_url FROM whatsapp_mensagens m
            JOIN whatsapp_conversas c ON c.id = m.conversa_id
            JOIN whatsapp_contatos ct ON ct.id = c.contato_id
            WHERE ct.empresa_id = ? AND m.midia_url IS NOT NULL
            """,
            (g.empresa_id,),
        ).fetchall()
        whatsapp_service.apagar_todos_dados_clientes(conn, g.empresa_id)
        for row in midias:
            nome_arquivo = os.path.basename(row["midia_url"])
            caminho = os.path.join(PASTA_UPLOADS, nome_arquivo)
            if os.path.isfile(caminho):
                try:
                    os.remove(caminho)
                except OSError:
                    pass

    usuario = g.usuario_atual
    whatsapp_service.registrar_atividade(conn, usuario["id"], "whatsapp_desconectado", f"limpeza={limpeza}")
    return jsonify({"ok": True})


# ============================================================
# CONVERSAS E MENSAGENS — visibilidade por atribuição (ver nota do
# topo do arquivo): dono da conversa, ou admin, ou (só leitura) fila.
# ============================================================
def _apelidos_contatos():
    """Apelidos privados de contato do usuário logado. Carregado uma vez
    por requisição — uma lista de 300 conversas usa o mesmo mapa, não
    adianta consultar o banco pra cada linha."""
    if not hasattr(g, "_cache_apelidos_contatos"):
        g._cache_apelidos_contatos = whatsapp_service.obter_apelidos_contatos(get_db(), g.usuario_atual["id"])
    return g._cache_apelidos_contatos


def _conversa_para_json(row, tags=None):
    d = dict(row)
    d["nao_lidas"] = int(d.get("nao_lidas") or 0)
    d["tags"] = tags or []
    d["sugerir_encerrar"] = _sugerir_encerrar(row)
    d["horas_sugerir_encerrar"] = HORAS_SUGERIR_ENCERRAR
    # Nome que ESTE usuário deu pro contato ganha da versão compartilhada
    # (o nome de cadastro segue guardado, só não é o que ele vê).
    apelido = _apelidos_contatos().get(d.get("contato_id"))
    if apelido:
        d["contato_nome_real"] = d.get("contato_nome")
        d["contato_nome"] = apelido
    if d.get("atribuida_usuario_id"):
        d["atribuida_usuario_online"] = whatsapp_service.usuario_esta_online(
            d.pop("_u_ultimo_acesso", None), d.pop("_u_offline_forcado", 0)
        )
    else:
        d.pop("_u_ultimo_acesso", None)
        d.pop("_u_offline_forcado", None)
        d["atribuida_usuario_online"] = None
    return d


# Depois de quantas horas paradas o sistema sugere encerrar. Não é
# alerta de atraso (isso é o SLA, em minutos): é o lembrete de fechar um
# atendimento que já acabou e ficou aberto por esquecimento.
HORAS_SUGERIR_ENCERRAR = int(os.environ.get("WPP_HORAS_SUGERIR_ENCERRAR", "24"))


def _sugerir_encerrar(conversa) -> bool:
    """Conversa aberta, com dono, parada há tempo demais.

    Sem isso, atendimento terminado fica aberto para sempre: some da
    cabeça de quem atende, continua contando como conversa ativa e o
    cliente, quando volta, cai no atendimento antigo em vez de passar
    pelo menu."""
    if conversa["status"] != "aberta" or conversa["atribuida_usuario_id"] is None:
        return False
    quando = conversa["ultima_mensagem_em"]
    if not quando:
        return False
    limite = (datetime.datetime.utcnow() - datetime.timedelta(hours=HORAS_SUGERIR_ENCERRAR))
    return quando <= limite.strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def _conversas_com_tags(conn, rows):
    mapa_tags = whatsapp_service.tags_por_conversa(conn, [r["id"] for r in rows], g.usuario_atual["id"])
    return [_conversa_para_json(r, mapa_tags.get(r["id"], [])) for r in rows]


def _recusa_atribuida(conversa, complemento=""):
    """Mensagem de recusa dizendo COM QUEM a conversa está.

    Antes dizia só "está atribuída a outro usuário", e quem esbarrava
    nisso não tinha como descobrir com quem falar — tinha que perguntar
    de mesa em mesa."""
    nome = None
    if "atribuida_usuario_nome" in conversa.keys():
        nome = conversa["atribuida_usuario_nome"]
    if nome:
        return f"Esta conversa está com {nome}.{complemento}"
    return f"Esta conversa está atribuída a outro usuário.{complemento}"


def _carregar_conversa(conn, empresa_id, conversa_id):
    """empresa_id sempre filtra aqui — é o único ponto que TODA rota de
    conversa passa antes de fazer qualquer coisa, então uma conversa de
    outra empresa simplesmente não existe do ponto de vista de quem
    pediu (404, igual não existisse mesmo) — isolamento entre empresas
    depende inteiramente deste filtro."""
    conversa = conn.execute(
        "SELECT c.*, ct.telefone, ct.nome AS contato_nome, ct.foto_url AS contato_foto, "
        "u.nome AS atribuida_usuario_nome "
        "FROM whatsapp_conversas c "
        "JOIN whatsapp_contatos ct ON ct.id = c.contato_id "
        "LEFT JOIN usuarios u ON u.id = c.atribuida_usuario_id "
        "WHERE c.id = ? AND ct.empresa_id = ?",
        (conversa_id, empresa_id),
    ).fetchone()
    if conversa is None:
        raise ApiError("Conversa não encontrada.", status=404, codigo="nao_encontrado")
    return conversa


def _limite_sem_menu(conn):
    """Instante a partir do qual uma conversa sem setor já esperou
    demais e vira fila de todo mundo. Devolve texto ISO pra comparar
    direto no SQL."""
    import datetime as _dt
    config = whatsapp_service.obter_configuracao(conn, g.empresa_id)
    minutos = config.get("minutos_liberar_sem_menu")
    if minutos is None:
        minutos = 2
    return (_dt.datetime.utcnow() - _dt.timedelta(minutes=int(minutos))).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def _esperou_demais_sem_menu(conn, conversa):
    if conversa["menu_setor"]:
        return False
    quando = conversa["ultima_mensagem_em"] or conversa["criado_em"]
    return bool(quando) and quando <= _limite_sem_menu(conn)


def _pode_visualizar(usuario, conversa, conn=None):
    """Atribuída: só o dono (e o admin). Sem dono (na fila): só quem
    atende o setor pra onde o cliente foi direcionado — mesma régua do
    botão Assumir. Enquanto o setor não está definido (cliente ainda não
    respondeu o menu), só o admin vê: não dá pra saber de quem é.

    Uma pessoa pode atender vários setores, então a comparação é contra
    a lista dela, não contra um valor único."""
    if usuario["admin"]:
        return True
    if conversa["atribuida_usuario_id"] is not None:
        return conversa["atribuida_usuario_id"] == usuario["id"]
    conn = conn or get_db()
    if not conversa["menu_setor"]:
        # Sem setor: era invisível pra todo mundo menos o admin, e o
        # cliente que não responde o menu ficava esperando sem ninguém
        # saber. Passado o tempo configurado, vira fila de todos.
        return _esperou_demais_sem_menu(conn, conversa)
    return conversa["menu_setor"] in whatsapp_service.setores_do_usuario(conn, usuario["id"])


# Mesma regra do _pode_visualizar, em SQL, pra filtrar as listas direto no
# banco (o usuário nunca chega a receber a conversa de outro setor).
def _sql_visivel_nao_admin(conn, usuario):
    """Condição SQL + parâmetros do que esta pessoa pode ver: o que está
    atribuído a ela, mais a fila dos setores que ela atende.

    Vira função (em vez de constante) porque a pessoa pode atender vários
    setores — a quantidade de marcadores muda de um usuário pro outro."""
    setores = whatsapp_service.setores_do_usuario(conn, usuario["id"])
    limite = _limite_sem_menu(conn)
    # Conversa sem setor que já esperou demais entra na fila de todos —
    # é o cliente que não escolheu número nenhum no menu e, sem isso,
    # ficaria invisível pra equipe inteira.
    sem_menu = ("(c.atribuida_usuario_id IS NULL AND c.menu_setor IS NULL "
                "AND COALESCE(c.ultima_mensagem_em, c.criado_em) <= ?)")
    if not setores:
        return f"(c.atribuida_usuario_id = ? OR {sem_menu})", [usuario["id"], limite]
    marcadores = ",".join("?" * len(setores))
    sql = (
        f"(c.atribuida_usuario_id = ? "
        f"OR (c.atribuida_usuario_id IS NULL AND c.menu_setor IN ({marcadores})) "
        f"OR {sem_menu})"
    )
    return sql, [usuario["id"], *setores, limite]


# Direção da última mensagem da conversa: 'entrada' = o cliente falou por
# último (está esperando resposta), 'saida' = nós falamos por último.
# É o que separa a aba "Fila" (aguardando) da "Minhas" (em andamento).
_SQL_ULTIMA_DIRECAO = (
    "(SELECT m.direcao FROM whatsapp_mensagens m WHERE m.conversa_id = c.id "
    "AND m.excluida_em IS NULL ORDER BY m.criado_em DESC, m.id DESC LIMIT 1)"
)


def _pode_agir(usuario, conversa):
    """Responder/fechar/encaminhar. Uma conversa da fila (sem dono ainda)
    pode ser respondida por quem é do setor dela — a primeira resposta
    assume ela automaticamente (ver enviar_mensagem). Uma vez atribuída,
    só o dono (ou um admin). Quem consegue agir é sempre um subconjunto
    de quem consegue ver, então a régua é a mesma do _pode_visualizar."""
    return _pode_visualizar(usuario, conversa)


@bp.get("/conversas")
@requires_auth
def listar_conversas():
    usuario = g.usuario_atual
    escopo = request.args.get("escopo", "minhas")
    conn = get_db()

    incluir_arquivadas = request.args.get("arquivadas") == "1"

    base = """
        SELECT c.*, ct.telefone, ct.nome AS contato_nome, ct.foto_url AS contato_foto,
               u.nome AS atribuida_usuario_nome,
               u.ultimo_acesso AS _u_ultimo_acesso, u.offline_forcado AS _u_offline_forcado
        FROM whatsapp_conversas c
        JOIN whatsapp_contatos ct ON ct.id = c.contato_id
        LEFT JOIN usuarios u ON u.id = c.atribuida_usuario_id
    """
    if escopo == "fila":
        # "Fila" = SEM DONO, esperando alguém pegar.
        #
        # Antes a fila era "aguardando resposta nossa", e incluía as
        # conversas já atribuídas em que o cliente tinha falado por
        # último. Na prática isso jogava o atendimento pra fora de
        # "Minhas" toda vez que o cliente respondia — quem estava no meio
        # da conversa via ela sumir da própria aba. Agora conversa com
        # dono fica com o dono, ponto; a fila é só o que ainda é de
        # ninguém.
        if usuario["admin"]:
            condicoes, params = [], []
        else:
            sql_visivel, params = _sql_visivel_nao_admin(conn, usuario)
            condicoes = [sql_visivel]
        condicoes.append("c.atribuida_usuario_id IS NULL")
    elif escopo == "sem_menu":
        # Quem entrou em contato e não escolheu nenhum número do menu.
        # Aba própria pra dar pra ver de uma vez quem está travado aí —
        # inclusive os que ainda não completaram o tempo de espera.
        if usuario["admin"]:
            condicoes, params = [], []
        else:
            sql_visivel, params = _sql_visivel_nao_admin(conn, usuario)
            condicoes = [sql_visivel]
        condicoes.append("c.menu_setor IS NULL")
        condicoes.append("c.atribuida_usuario_id IS NULL")
    elif escopo == "todas":
        if not usuario["admin"]:
            raise ApiError("Só um administrador pode ver todas as conversas.", status=403, codigo="sem_permissao")
        condicoes, params = [], []
    else:
        # "Minhas" = tudo o que está comigo, tenha falado quem tiver
        # falado por último. Se é meu atendimento, ele não sai daqui
        # porque o cliente respondeu — quem avisa que há algo novo é o
        # contador de não lidas.
        condicoes = ["c.atribuida_usuario_id = ?"]
        params = [usuario["id"]]
    condicoes.append("ct.empresa_id = ?")
    params.append(g.empresa_id)

    # Excluídas nunca aparecem em lista nenhuma. Arquivadas só aparecem
    # se pedidas explicitamente (?arquivadas=1) — senão ficam fora do
    # fluxo normal, sem sumir de verdade (dá pra desarquivar depois).
    condicoes.append("c.excluida_em IS NULL")
    condicoes.append("c.arquivada = 1" if incluir_arquivadas else "c.arquivada = 0")

    # Filtro por etiqueta. Vale junto com a aba escolhida (dá pra ver só
    # os "Orçamento enviado" que estão na fila, por exemplo).
    tag_id = request.args.get("tag_id")
    if tag_id:
        # t2.usuario_id: filtrar pelo id de uma etiqueta alheia não pode
        # devolver nada — nem revelar que ela existe.
        condicoes.append(
            "EXISTS (SELECT 1 FROM whatsapp_conversa_tags ct2 "
            "JOIN whatsapp_tags t2 ON t2.id = ct2.tag_id "
            "WHERE ct2.conversa_id = c.id AND ct2.tag_id = ? AND t2.empresa_id = ? AND t2.usuario_id = ?)"
        )
        params.extend([tag_id, g.empresa_id, g.usuario_atual["id"]])

    where = "WHERE " + " AND ".join(condicoes)
    rows = conn.execute(
        f"{base} {where} ORDER BY COALESCE(c.ultima_mensagem_em, c.criado_em) DESC LIMIT 300", params
    ).fetchall()
    return jsonify(_conversas_com_tags(conn, rows))


@bp.get("/pulso")
@requires_auth
def pulso():
    """Diz, em uma consulta minúscula, se apareceu alguma coisa nova.

    Existe pra tela poder perguntar MUITAS vezes por segundo sem pesar:
    buscar a lista de conversas inteira a cada meio segundo seria caro,
    mas comparar dois números é barato. A tela só busca de verdade
    quando um destes valores muda — e é isso que faz a mensagem aparecer
    quase na hora, sem o servidor sentir.

    Devolve o id da última mensagem (de cliente e interna) e a soma das
    não-lidas. Qualquer coisa que importe pra tela mexe em pelo menos um
    desses.
    """
    usuario = g.usuario_atual
    conn = get_db()
    ultima_cliente = conn.execute(
        "SELECT COALESCE(MAX(m.id), 0) AS v FROM whatsapp_mensagens m "
        "JOIN whatsapp_conversas c ON c.id = m.conversa_id "
        "JOIN whatsapp_contatos ct ON ct.id = c.contato_id WHERE ct.empresa_id = ?",
        (g.empresa_id,),
    ).fetchone()["v"]
    ultima_interna = conn.execute(
        "SELECT COALESCE(MAX(m.id), 0) AS v FROM chat_interno_mensagens m "
        "JOIN chat_interno_conversas c ON c.id = m.conversa_id "
        "JOIN usuarios u ON u.id = c.criado_por_id WHERE u.empresa_id = ?",
        (g.empresa_id,),
    ).fetchone()["v"]
    # "visto" entra no pulso pra o ✓✓ do chat interno aparecer na hora
    # em que o outro lado abre a conversa — sem isso, só na mensagem
    # seguinte.
    vistos = conn.execute(
        "SELECT COALESCE(MAX(COALESCE(visto_criador_em, '')) || MAX(COALESCE(visto_participante_em, '')), '') AS v "
        "FROM chat_interno_conversas c JOIN usuarios u ON u.id = c.criado_por_id WHERE u.empresa_id = ?",
        (g.empresa_id,),
    ).fetchone()["v"]
    # Status das nossas mensagens (enviada -> entregue -> lida): muda sem
    # criar mensagem nenhuma, então precisa entrar aqui — é o que faz o
    # ✓✓ azul aparecer sozinho, sem esperar a próxima mensagem.
    #
    # Só da conversa ABERTA, não da empresa inteira: status de conversa
    # que ninguém está olhando não muda nada na tela, e contar isso em
    # todo o histórico era o passo mais caro do pulso — ficava mais
    # pesado que buscar a lista inteira, justamente o que este endereço
    # existe pra evitar.
    status = ""
    conversa_id = request.args.get("conversa_id")
    if conversa_id:
        linha = conn.execute(
            "SELECT COUNT(*) AS total, "
            "SUM(CASE WHEN m.status = 'lida' THEN 1 ELSE 0 END) AS lidas, "
            "SUM(CASE WHEN m.status = 'entregue' THEN 1 ELSE 0 END) AS entregues "
            "FROM whatsapp_mensagens m JOIN whatsapp_conversas c ON c.id = m.conversa_id "
            "JOIN whatsapp_contatos ct ON ct.id = c.contato_id "
            "WHERE m.conversa_id = ? AND ct.empresa_id = ? AND m.direcao = 'saida'",
            (conversa_id, g.empresa_id),
        ).fetchone()
        reagidas = conn.execute(
            "SELECT COUNT(*) AS v FROM whatsapp_mensagens WHERE conversa_id = ? AND reacao IS NOT NULL",
            (conversa_id,),
        ).fetchone()["v"]
        status = f"{linha['total']}.{linha['lidas'] or 0}.{linha['entregues'] or 0}.{reagidas}"
    return jsonify({"c": ultima_cliente, "i": ultima_interna, "v": vistos, "s": status})


@bp.get("/conversas/<int:conversa_id>")
@requires_auth
def obter_conversa(conversa_id):
    """Uma conversa específica, respeitando a permissão de quem pede.

    Existe porque a tela precisa abrir uma conversa que não está na aba
    atual (ex.: a pessoa assumiu o atendimento e voltou pra aba Fila).
    Antes ela caía em ?escopo=todas — que é só de admin —, levava 403 e
    abria sem o campo de digitar: dava a impressão de que a conversa
    tinha travado, e só fechar e reabrir o sistema resolvia."""
    usuario = g.usuario_atual
    conn = get_db()
    conversa = _carregar_conversa(conn, g.empresa_id, conversa_id)
    if not _pode_visualizar(usuario, conversa, conn):
        raise ApiError(_recusa_atribuida(conversa), status=403, codigo="sem_permissao")
    return jsonify(_conversas_com_tags(conn, [conversa])[0])


@bp.get("/contagem-abas")
@requires_auth
def contagem_abas():
    """Quantas conversas há em cada aba, pra quem está pedindo.

    Serve pra mostrar o número na própria aba: sem isso, saber que caiu
    alguém na Fila exige clicar em Fila. Respeita a mesma régua de
    visibilidade das listas — ninguém conta o que não pode ver."""
    usuario = g.usuario_atual
    conn = get_db()
    base = ("FROM whatsapp_conversas c JOIN whatsapp_contatos ct ON ct.id = c.contato_id "
            "WHERE ct.empresa_id = ? AND c.excluida_em IS NULL AND c.arquivada = 0")
    if usuario["admin"]:
        visivel, pv = "", []
    else:
        sql, pv = _sql_visivel_nao_admin(conn, usuario)
        visivel = " AND " + sql

    def contar(extra, params_extra=()):
        return conn.execute(
            f"SELECT COUNT(*) AS n {base}{visivel} {extra}",
            [g.empresa_id, *pv, *params_extra],
        ).fetchone()["n"]

    minhas = conn.execute(
        f"SELECT COUNT(*) AS n {base} AND c.atribuida_usuario_id = ?",
        (g.empresa_id, usuario["id"]),
    ).fetchone()["n"]
    # Não lidas: é o que de fato pede atenção agora.
    nao_lidas_minhas = conn.execute(
        f"SELECT COALESCE(SUM(c.nao_lidas), 0) AS n {base} AND c.atribuida_usuario_id = ?",
        (g.empresa_id, usuario["id"]),
    ).fetchone()["n"]
    return jsonify({
        "minhas": minhas,
        "minhas_nao_lidas": nao_lidas_minhas,
        "fila": contar("AND c.atribuida_usuario_id IS NULL"),
        "sem_menu": contar("AND c.atribuida_usuario_id IS NULL AND c.menu_setor IS NULL"),
        "todas": conn.execute(f"SELECT COUNT(*) AS n {base}", (g.empresa_id,)).fetchone()["n"] if usuario["admin"] else None,
    })


@bp.get("/conversas/buscar")
@requires_auth
def buscar_conversas():
    usuario = g.usuario_atual
    q = (request.args.get("q") or "").strip()
    if len(q) < 2:
        raise ApiError("Digite ao menos 2 caracteres pra buscar.", status=400)
    conn = get_db()
    termo = f"%{q}%"
    # Telefone é guardado só com dígitos (5548991212203), mas ninguém
    # digita assim: vem "(48) 99121-2203", "48 99121 2203", "99121-2203".
    # Comparando só os dígitos, qualquer uma dessas formas acha o mesmo
    # contato. Abaixo de 4 dígitos não vale a pena — "48" casaria com
    # quase todo número do país.
    digitos = re.sub(r"\D", "", q)
    por_telefone = "ct.telefone LIKE ?"
    condicoes = [
        "ct.empresa_id = ?",
        "c.excluida_em IS NULL",
        f"(ct.nome LIKE ? OR {por_telefone} OR EXISTS ("
        "SELECT 1 FROM whatsapp_mensagens m WHERE m.conversa_id = c.id AND m.texto LIKE ? AND m.excluida_em IS NULL))",
    ]
    params = [g.empresa_id, termo, f"%{digitos}%" if len(digitos) >= 4 else termo, termo]
    if not usuario["admin"]:
        sql_visivel, params_visivel = _sql_visivel_nao_admin(conn, usuario)
        condicoes.append(sql_visivel)
        params.extend(params_visivel)
    where = "WHERE " + " AND ".join(condicoes)
    rows = conn.execute(
        f"""
        SELECT c.*, ct.telefone, ct.nome AS contato_nome, ct.foto_url AS contato_foto,
               u.nome AS atribuida_usuario_nome,
               u.ultimo_acesso AS _u_ultimo_acesso, u.offline_forcado AS _u_offline_forcado
        FROM whatsapp_conversas c
        JOIN whatsapp_contatos ct ON ct.id = c.contato_id
        LEFT JOIN usuarios u ON u.id = c.atribuida_usuario_id
        {where} ORDER BY COALESCE(c.ultima_mensagem_em, c.criado_em) DESC LIMIT 50
        """,
        params,
    ).fetchall()
    return jsonify(_conversas_com_tags(conn, rows))


@bp.get("/sla-alertas")
@requires_auth
def sla_alertas():
    usuario = g.usuario_atual
    conn = get_db()
    rows = whatsapp_service.listar_conversas_sla_estourado(
        conn, g.empresa_id,
        None if usuario["admin"] else usuario["id"],
        None if usuario["admin"] else usuario["setor"],
    )
    return jsonify([_conversa_para_json(r) for r in rows])


@bp.get("/contatos")
@requires_auth
def listar_contatos():
    conn = get_db()
    q = (request.args.get("q") or "").strip()
    if q:
        termo = f"%{q}%"
        # Ver buscar_conversas: compara só os dígitos, pra achar o
        # contato mesmo com o número digitado com máscara.
        digitos = re.sub(r"\D", "", q)
        termo_tel = f"%{digitos}%" if len(digitos) >= 4 else termo
        rows = conn.execute(
            "SELECT id, nome, telefone, foto_url, eh_grupo FROM whatsapp_contatos WHERE empresa_id = ? AND (nome LIKE ? OR telefone LIKE ?) ORDER BY nome LIMIT 200",
            (g.empresa_id, termo, termo_tel),
        ).fetchall()
    else:
        rows = conn.execute("SELECT id, nome, telefone, foto_url, eh_grupo FROM whatsapp_contatos WHERE empresa_id = ? ORDER BY nome LIMIT 500", (g.empresa_id,)).fetchall()
    apelidos = _apelidos_contatos()
    contatos = []
    for r in rows:
        d = dict(r)
        if apelidos.get(d["id"]):
            d["nome"] = apelidos[d["id"]]
        contatos.append(d)
    return jsonify(contatos)


@bp.put("/contatos/<int:contato_id>/apelido")
@requires_auth
def definir_apelido_contato(contato_id):
    """Nome que só este usuário vê pra esse contato. Em branco, volta pro
    nome de cadastro."""
    conn = get_db()
    existe = conn.execute(
        "SELECT 1 FROM whatsapp_contatos WHERE id = ? AND empresa_id = ?", (contato_id, g.empresa_id)
    ).fetchone()
    if existe is None:
        raise ApiError("Contato não encontrado.", status=404, codigo="nao_encontrado")
    dados = request.get_json(silent=True) or {}
    whatsapp_service.definir_apelido_contato(conn, g.usuario_atual["id"], contato_id, dados.get("apelido"))
    return jsonify({"ok": True})


@bp.put("/contatos/<int:contato_id>")
@requires_auth
def editar_contato(contato_id):
    """Corrige o cadastro do contato — o nome escrito errado na hora de
    adicionar, por exemplo.

    Diferente do apelido (PUT /contatos/<id>/apelido), que é uma
    preferência individual: aqui é o nome de cadastro, e a correção vale
    para a empresa inteira. Quem tiver apelido próprio continua vendo o
    apelido dele.

    O telefone só pode ser trocado enquanto o contato não tem conversa
    nenhuma: ele é o que liga a conversa ao cliente no WhatsApp, e mudar
    depois faria as mensagens já trocadas apontarem para outro número.
    """
    conn = get_db()
    contato = conn.execute(
        "SELECT * FROM whatsapp_contatos WHERE id = ? AND empresa_id = ?", (contato_id, g.empresa_id)
    ).fetchone()
    if contato is None:
        raise ApiError("Contato não encontrado.", status=404, codigo="nao_encontrado")

    dados = request.get_json(silent=True) or {}
    nome = (dados.get("nome") or "").strip()
    if not nome:
        raise ApiError("Informe o nome do contato.", status=400)

    telefone = (dados.get("telefone") or "").strip()
    if telefone:
        telefone = whatsapp_service.normalizar_telefone(telefone)
    if telefone and telefone != contato["telefone"]:
        tem_conversa = conn.execute(
            "SELECT 1 FROM whatsapp_conversas WHERE contato_id = ?", (contato_id,)
        ).fetchone()
        if tem_conversa:
            raise ApiError(
                "Este contato já tem conversa, então o telefone não pode ser trocado — "
                "as mensagens já trocadas ficariam ligadas ao número errado. Cadastre o número certo como um novo contato.",
                status=400,
            )
        duplicado = conn.execute(
            "SELECT 1 FROM whatsapp_contatos WHERE empresa_id = ? AND telefone = ? AND id != ?",
            (g.empresa_id, telefone, contato_id),
        ).fetchone()
        if duplicado:
            raise ApiError("Já existe outro contato com esse telefone.", status=409, codigo="telefone_duplicado")
        conn.execute(
            "UPDATE whatsapp_contatos SET nome = ?, telefone = ?, atualizado_em = ? WHERE id = ?",
            (nome, telefone, _now_iso(), contato_id),
        )
    else:
        conn.execute(
            "UPDATE whatsapp_contatos SET nome = ?, atualizado_em = ? WHERE id = ?",
            (nome, _now_iso(), contato_id),
        )
    whatsapp_service.registrar_atividade(conn, g.usuario_atual["id"], "contato_editado", nome)
    return jsonify(dict(conn.execute("SELECT * FROM whatsapp_contatos WHERE id = ?", (contato_id,)).fetchone()))


@bp.post("/contatos")
@requires_auth
def criar_contato():
    dados = request.get_json(silent=True) or {}
    telefone = (dados.get("telefone") or "").strip()
    if not telefone:
        raise ApiError("Informe o telefone.", status=400)
    conn = get_db()
    contato = whatsapp_service.salvar_contato_manual(conn, g.empresa_id, telefone, dados.get("nome"))
    return jsonify(contato), 201


@bp.post("/upload-avulso")
@requires_auth
def upload_avulso():
    """Guarda um arquivo e devolve o endereço dele, sem prender a
    nenhuma conversa. Usado pela foto do grupo: o WhatsApp busca a
    imagem por URL, então ela precisa estar num endereço público ANTES
    do grupo existir."""
    arquivo = request.files.get("arquivo")
    if arquivo is None or not arquivo.filename:
        raise ApiError("Nenhum arquivo enviado.", status=400)
    nome_original = secure_filename(arquivo.filename) or "arquivo"
    if _classificar_tipo(nome_original) != "imagem":
        raise ApiError("Só imagem por aqui.", status=400)
    os.makedirs(PASTA_UPLOADS, exist_ok=True)
    nome_seguro = f"{secrets.token_hex(8)}_{nome_original}"
    caminho = os.path.join(PASTA_UPLOADS, nome_seguro)
    arquivo.save(caminho)
    if os.path.getsize(caminho) > MAX_ANEXO_MB * 1024 * 1024:
        os.remove(caminho)
        raise ApiError(f"Arquivo maior que {MAX_ANEXO_MB}MB.", status=400)
    return jsonify({"url": f"/api/v1/whatsapp/uploads/{nome_seguro}"}), 201


@bp.post("/grupos")
@requires_auth
def criar_grupo():
    """Cria um grupo no WhatsApp com os contatos escolhidos.

    O grupo entra no sistema como um contato marcado com eh_grupo, e já
    ganha uma conversa — daí em diante ele se comporta como qualquer
    outra: aparece na lista, aceita mensagem, anexo, etiqueta.
    """
    usuario = g.usuario_atual
    dados = request.get_json(silent=True) or {}
    nome = (dados.get("nome") or "").strip()
    if not nome:
        raise ApiError("Dê um nome ao grupo.", status=400)
    telefones = [t for t in (dados.get("telefones") or []) if (t or "").strip()]
    if not telefones:
        raise ApiError("Escolha pelo menos uma pessoa para o grupo.", status=400)

    conn = get_db()
    config = whatsapp_service.obter_configuracao(conn, g.empresa_id)
    grupo = whatsapp_service.criar_grupo(config, nome, telefones, (dados.get("descricao") or "").strip() or None)

    # A foto é opcional e vai depois: o grupo já existe, e falhar aqui
    # não pode desfazer o que deu certo.
    foto_url = None
    imagem = (dados.get("imagem_url") or "").strip()
    if imagem:
        publica = imagem if imagem.startswith("http") else whatsapp_service.url_publica(config, imagem)
        if whatsapp_service.definir_foto_grupo(config, grupo["jid"], publica):
            foto_url = imagem

    agora = whatsapp_service._now_iso()
    conn.execute(
        "INSERT INTO whatsapp_contatos (empresa_id, telefone, nome, foto_url, eh_grupo, criado_em, atualizado_em) "
        "VALUES (?, ?, ?, ?, 1, ?, ?)",
        (g.empresa_id, grupo["id"], nome, foto_url, agora, agora),
    )
    contato_id = conn.execute("SELECT id FROM whatsapp_contatos WHERE empresa_id = ? AND telefone = ?",
                              (g.empresa_id, grupo["id"])).fetchone()["id"]
    conversa, _ = whatsapp_service.obter_ou_criar_conversa(conn, contato_id)
    # Quem criou já fica responsável — senão o grupo nasceria numa fila
    # sem setor, esperando alguém assumir algo que já tem dono.
    whatsapp_service.atribuir_conversa(conn, conversa["id"], usuario["id"], usuario["id"])
    whatsapp_service.registrar_atividade(conn, usuario["id"], "grupo_criado", nome, conversa["id"])
    return jsonify({"conversa_id": conversa["id"], "contato_id": contato_id,
                    "nome": nome, "id_grupo": grupo["id"], "foto_url": foto_url}), 201


@bp.post("/grupos/<int:conversa_id>/participantes")
@requires_auth
def adicionar_participantes(conversa_id):
    """Adiciona gente a um grupo que já existe."""
    usuario = g.usuario_atual
    conn = get_db()
    conversa = _carregar_conversa(conn, g.empresa_id, conversa_id)
    if not _pode_agir(usuario, conversa):
        raise ApiError(_recusa_atribuida(conversa), status=403, codigo="sem_permissao")
    contato = conn.execute("SELECT * FROM whatsapp_contatos WHERE id = ?", (conversa["contato_id"],)).fetchone()
    if not contato["eh_grupo"]:
        raise ApiError("Essa conversa não é um grupo.", status=400)
    telefones = [t for t in ((request.get_json(silent=True) or {}).get("telefones") or []) if (t or "").strip()]
    if not telefones:
        raise ApiError("Escolha pelo menos uma pessoa.", status=400)
    config = whatsapp_service.obter_configuracao(conn, g.empresa_id)
    whatsapp_service.adicionar_ao_grupo(config, f"{contato['telefone']}@g.us", telefones)
    whatsapp_service.registrar_atividade(conn, usuario["id"], "grupo_participantes", contato["nome"], conversa_id)
    return jsonify({"ok": True, "adicionados": len(telefones)})


@bp.post("/contatos/importar")
@requires_auth
def importar_contatos():
    """Importa contatos em lote de um CSV ou VCF exportado do celular —
    não cria conversa nenhuma, só deixa os contatos disponíveis pra
    'Nova conversa' sem precisar digitar telefone um por um."""
    arquivo = request.files.get("arquivo")
    if not arquivo or not arquivo.filename:
        raise ApiError("Nenhum arquivo enviado.", status=400)
    conteudo_bytes = arquivo.read()
    if len(conteudo_bytes) > 5 * 1024 * 1024:
        raise ApiError("Arquivo maior que o limite de 5MB.", status=400)
    try:
        conteudo = conteudo_bytes.decode("utf-8-sig")
    except UnicodeDecodeError:
        conteudo = conteudo_bytes.decode("latin-1")
    conn = get_db()
    resultado = whatsapp_service.importar_contatos(conn, g.empresa_id, conteudo, arquivo.filename)
    whatsapp_service.registrar_atividade(
        conn, g.usuario_atual["id"], "contatos_importados",
        f"{resultado['importados']} novos, {resultado['ja_existiam']} já existiam",
    )
    return jsonify(resultado), 201


@bp.post("/conversas")
@requires_auth
def iniciar_conversa():
    """Começa uma conversa nova (o usuário manda a primeira mensagem pra
    um número que ainda não tinha falado com a empresa) — diferente do
    resto do fluxo, onde a conversa sempre nasce de uma mensagem do
    cliente chegando pelo webhook. Se já existir uma conversa com esse
    número, reaproveita ela em vez de criar duplicada; se já for de
    outro usuário, recusa (mesma régua de _pode_agir do resto do app)."""
    usuario = g.usuario_atual
    dados = request.get_json(silent=True) or {}
    telefone_bruto = (dados.get("telefone") or "").strip()
    nome = (dados.get("nome") or "").strip() or None
    texto = (dados.get("texto") or "").strip()
    if not telefone_bruto:
        raise ApiError("Informe o telefone.", status=400)
    if not texto:
        raise ApiError("Informe a mensagem inicial.", status=400)

    conn = get_db()
    telefone = whatsapp_service.normalizar_telefone(telefone_bruto)
    contato = whatsapp_service.obter_ou_criar_contato(conn, g.empresa_id, telefone, nome)

    conversa_existente = conn.execute(
        "SELECT id FROM whatsapp_conversas WHERE contato_id = ? ORDER BY id DESC LIMIT 1", (contato["id"],)
    ).fetchone()
    if conversa_existente:
        conversa = _carregar_conversa(conn, g.empresa_id, conversa_existente["id"])
        # Na fila (sem dono): qualquer atendente pode puxar pra si, mesmo
        # que o cliente ainda não tenha escolhido setor — é o caso de
        # quem está esperando e alguém reconhece pelo nome ou telefone.
        # Já atribuída: recusa, dizendo com quem está.
        if conversa["atribuida_usuario_id"] is not None and not _pode_agir(usuario, conversa):
            raise ApiError(_recusa_atribuida(conversa, " Peça pra ela encaminhar, ou fale com um administrador."),
                           status=409, codigo="conversa_existente")
    else:
        nova, _ = whatsapp_service.obter_ou_criar_conversa(conn, contato["id"])
        conversa = _carregar_conversa(conn, nova["id"])

    whatsapp_service.verificar_repeticao_mensagem(conn, g.empresa_id, texto)

    if conversa["atribuida_usuario_id"] is None:
        whatsapp_service.atribuir_conversa(conn, conversa["id"], usuario["id"], usuario["id"])

    config = whatsapp_service.obter_configuracao(conn, g.empresa_id)
    agora = _now_iso()
    try:
        externo_id = whatsapp_service.enviar_texto(config, telefone, texto)
        status_msg, erro = "enviada", None
    except ApiError as e:
        externo_id, status_msg, erro = None, "falhou", e.mensagem

    conn.execute(
        """
        INSERT INTO whatsapp_mensagens (conversa_id, direcao, tipo, texto, externo_id, usuario_id, status, erro, criado_em)
        VALUES (?, 'saida', 'texto', ?, ?, ?, ?, ?, ?)
        """,
        (conversa["id"], texto, externo_id, usuario["id"], status_msg, erro, agora),
    )
    conn.execute(
        "UPDATE whatsapp_conversas SET status = 'aberta', fechada_em = NULL, ultima_mensagem_em = ?, ultima_mensagem_preview = ?, "
        "ultima_msg_operador_em = ?, proximo_contato_em = NULL, followup_adiado_ate = NULL WHERE id = ?",
        (agora, texto[:120], agora, conversa["id"]),
    )
    whatsapp_service.registrar_atividade(conn, usuario["id"], "conversa_iniciada", telefone, conversa["id"])
    # Mesmo se o ENVIO real falhar, a conversa já existe e a mensagem já
    # foi registrada — sempre devolve sucesso (o operador é levado até a
    # conversa de qualquer jeito, com o aviso ⚠️ visível nela), em vez de
    # um erro que travaria a navegação no meio do caminho.
    return jsonify({"conversa_id": conversa["id"], "envio_ok": status_msg == "enviada", "aviso": erro}), 201


@bp.get("/conversas/<int:conversa_id>/mensagens")
@requires_auth
def listar_mensagens(conversa_id):
    usuario = g.usuario_atual
    conn = get_db()
    conversa = _carregar_conversa(conn, g.empresa_id, conversa_id)
    if not _pode_visualizar(usuario, conversa):
        raise ApiError(_recusa_atribuida(conversa), status=403, codigo="sem_permissao")

    # Mensagem apagada some pro usuário comum, mas o ADMIN continua vendo
    # (marcada, com quem apagou) — sem isso alguém podia apagar algo e não
    # sobrar registro nenhum pra supervisão.
    # citada_*: trecho da mensagem que esta responde, pra desenhar a
    # citação sem uma segunda ida ao servidor por mensagem.
    campos = (
        "SELECT m.*, ue.nome AS excluida_por_nome, "
        "cit.texto AS citada_texto, cit.direcao AS citada_direcao, "
        "cit.tipo AS citada_tipo, cit.excluida_em AS citada_excluida_em "
        "FROM whatsapp_mensagens m "
        "LEFT JOIN usuarios ue ON ue.id = m.excluida_por "
        "LEFT JOIN whatsapp_mensagens cit ON cit.id = m.responde_a "
    )
    # Mesma régua do chat interno: apagada só aparece em supervisão. Se a
    # conversa é do próprio admin, ele vê como qualquer atendente vê.
    supervisionando = usuario["admin"] and conversa["atribuida_usuario_id"] != usuario["id"]
    if supervisionando:
        rows = conn.execute(campos + "WHERE m.conversa_id = ? ORDER BY m.criado_em, m.id", (conversa_id,)).fetchall()
    else:
        rows = conn.execute(
            campos + "WHERE m.conversa_id = ? AND m.excluida_em IS NULL ORDER BY m.criado_em, m.id",
            (conversa_id,),
        ).fetchall()

    # Só zera o contador de não lidas quando quem está olhando é o DONO
    # da conversa — se for o admin espiando a conversa de outro usuário
    # (supervisão) ou alguém só espiando a fila antes de assumir, o
    # contador continua do jeito que o dono vai ver depois.
    if conversa["atribuida_usuario_id"] == usuario["id"]:
        conn.execute("UPDATE whatsapp_conversas SET nao_lidas = 0 WHERE id = ?", (conversa_id,))

    return jsonify([dict(r) for r in rows])


@bp.post("/conversas/<int:conversa_id>/mensagens")
@requires_auth
def enviar_mensagem(conversa_id):
    usuario = g.usuario_atual
    dados = request.get_json(silent=True) or {}
    texto = (dados.get("texto") or "").strip()
    if not texto:
        raise ApiError("Informe o texto da mensagem.", status=400)
    responde_a = dados.get("responde_a")

    conn = get_db()
    conversa = _carregar_conversa(conn, g.empresa_id, conversa_id)
    if not _pode_agir(usuario, conversa):
        raise ApiError(_recusa_atribuida(conversa, " Encaminhe para si mesmo antes de responder."), status=403, codigo="sem_permissao")

    whatsapp_service.verificar_repeticao_mensagem(conn, g.empresa_id, texto)

    # Responder uma conversa da fila assume ela automaticamente — evita
    # a etapa extra de "Assumir" antes de simplesmente responder.
    if conversa["atribuida_usuario_id"] is None:
        whatsapp_service.atribuir_conversa(conn, conversa_id, usuario["id"], usuario["id"])

    # Citada precisa ser desta MESMA conversa: sem conferir, dava pra
    # citar por id uma mensagem de outro cliente e o trecho citado
    # apareceria aqui.
    citada = None
    if responde_a:
        citada = conn.execute(
            "SELECT id, externo_id FROM whatsapp_mensagens WHERE id = ? AND conversa_id = ?",
            (responde_a, conversa_id),
        ).fetchone()
        if citada is None:
            raise ApiError("A mensagem citada não é desta conversa.", status=400)

    config = whatsapp_service.obter_configuracao(conn, g.empresa_id)
    agora = _now_iso()
    try:
        externo_id = whatsapp_service.enviar_texto(
            config, conversa["telefone"], texto,
            citar_externo_id=citada["externo_id"] if citada else None,
        )
        status_msg = "enviada"
        erro = None
    except ApiError as e:
        externo_id = None
        status_msg = "falhou"
        erro = e.mensagem

    cur = conn.execute(
        """
        INSERT INTO whatsapp_mensagens (conversa_id, direcao, tipo, texto, externo_id, usuario_id, status, erro, criado_em, responde_a)
        VALUES (?, 'saida', 'texto', ?, ?, ?, ?, ?, ?, ?)
        """,
        (conversa_id, texto, externo_id, usuario["id"], status_msg, erro, agora, citada["id"] if citada else None),
    )
    conn.execute(
        "UPDATE whatsapp_conversas SET status = 'aberta', fechada_em = NULL, ultima_mensagem_em = ?, ultima_mensagem_preview = ?, "
        "ultima_msg_operador_em = ?, proximo_contato_em = NULL, followup_adiado_ate = NULL WHERE id = ?",
        (agora, texto[:120], agora, conversa_id),
    )
    mensagem = dict(conn.execute("SELECT * FROM whatsapp_mensagens WHERE id = ?", (cur.lastrowid,)).fetchone())
    whatsapp_service.registrar_atividade(conn, usuario["id"], "mensagem_enviada", texto[:120], conversa_id)
    # Mesmo com falha no envio real, a mensagem já foi registrada (⚠️
    # visível nela) — sempre devolve sucesso, nunca trava a tela no meio
    # do envio (ver mesmo raciocínio em iniciar_conversa, acima).
    return jsonify(mensagem), 201


@bp.delete("/conversas/<int:conversa_id>/mensagens/<int:mensagem_id>")
@requires_auth
def excluir_mensagem(conversa_id, mensagem_id):
    """Apaga uma mensagem enviada por engano (texto, imagem, vídeo,
    documento) — ex.: mandada pro cliente errado. Só mensagens NOSSAS
    (direcao='saida') podem ser apagadas; mensagens recebidas do cliente
    não (não faz sentido "excluir" o que ele mandou)."""
    usuario = g.usuario_atual
    conn = get_db()
    conversa = _carregar_conversa(conn, g.empresa_id, conversa_id)
    if not _pode_agir(usuario, conversa):
        raise ApiError(_recusa_atribuida(conversa), status=403, codigo="sem_permissao")
    mensagem = conn.execute(
        "SELECT * FROM whatsapp_mensagens WHERE id = ? AND conversa_id = ?", (mensagem_id, conversa_id)
    ).fetchone()
    if mensagem is None:
        raise ApiError("Mensagem não encontrada.", status=404, codigo="nao_encontrado")
    if mensagem["direcao"] != "saida":
        raise ApiError("Só é possível excluir mensagens enviadas por nós.", status=400)
    config = whatsapp_service.obter_configuracao(conn, g.empresa_id)
    apagada_no_whatsapp = whatsapp_service.excluir_mensagem(conn, config, dict(mensagem), usuario["id"])
    whatsapp_service.registrar_atividade(conn, usuario["id"], "mensagem_excluida", conversa["telefone"], conversa_id)
    return jsonify({"ok": True, "apagada_no_whatsapp": apagada_no_whatsapp})


@bp.put("/conversas/<int:conversa_id>/mensagens/<int:mensagem_id>")
@requires_auth
def editar_mensagem(conversa_id, mensagem_id):
    """Corrige o texto de uma mensagem NOSSA. Fica marcada como editada —
    ninguém muda o que disse sem deixar rastro na conversa.

    Só vale aqui dentro: o WhatsApp do cliente continua com o texto
    original, porque a Evolution API não expõe edição de mensagem já
    entregue. A tela avisa isso antes de salvar."""
    usuario = g.usuario_atual
    conn = get_db()
    conversa = _carregar_conversa(conn, g.empresa_id, conversa_id)
    if not _pode_agir(usuario, conversa):
        raise ApiError(_recusa_atribuida(conversa), status=403, codigo="sem_permissao")
    mensagem = conn.execute(
        "SELECT * FROM whatsapp_mensagens WHERE id = ? AND conversa_id = ?", (mensagem_id, conversa_id)
    ).fetchone()
    if mensagem is None:
        raise ApiError("Mensagem não encontrada.", status=404, codigo="nao_encontrado")
    if mensagem["direcao"] != "saida":
        raise ApiError("Só dá pra editar mensagem enviada por você — o que o cliente escreveu fica como está.", status=400)
    if mensagem["excluida_em"]:
        raise ApiError("Essa mensagem foi apagada.", status=400)
    texto = (request.get_json(silent=True) or {}).get("texto", "").strip()
    if not texto:
        raise ApiError("Escreva o novo texto.", status=400)
    agora = _now_iso()
    conn.execute(
        "UPDATE whatsapp_mensagens SET texto = ?, editada_em = ? WHERE id = ?", (texto, agora, mensagem_id)
    )
    # Se era a última da conversa, a prévia da lista tem que acompanhar.
    ultima = conn.execute(
        "SELECT id FROM whatsapp_mensagens WHERE conversa_id = ? AND excluida_em IS NULL ORDER BY criado_em DESC, id DESC LIMIT 1",
        (conversa_id,),
    ).fetchone()
    if ultima and ultima["id"] == mensagem_id:
        conn.execute("UPDATE whatsapp_conversas SET ultima_mensagem_preview = ? WHERE id = ?", (texto[:120], conversa_id))
    whatsapp_service.registrar_atividade(conn, usuario["id"], "mensagem_editada", texto[:120], conversa_id)
    return jsonify(dict(conn.execute("SELECT * FROM whatsapp_mensagens WHERE id = ?", (mensagem_id,)).fetchone()))


def _caminho_do_anexo(midia_url: str):
    """Do endereço guardado na mensagem para o arquivo no disco.

    Confere que o nome não tem barra nem "..": a mensagem vem do banco,
    mas o webhook grava o que chega de fora, e um caminho montado sem
    conferir viraria porta pra ler arquivo de qualquer lugar do
    servidor."""
    if not midia_url or "/uploads/" not in midia_url:
        return None
    nome = midia_url.rsplit("/", 1)[-1]
    if not nome or nome != secure_filename(nome):
        return None
    caminho = os.path.join(PASTA_UPLOADS, nome)
    return caminho if os.path.exists(caminho) else None


@bp.post("/conversas/<int:conversa_id>/mensagens/<int:mensagem_id>/transcrever")
@requires_auth
def transcrever_audio_mensagem(conversa_id, mensagem_id):
    """Escreve o que foi falado no áudio, pra quem prefere (ou precisa)
    ler em vez de ouvir.

    Guarda o resultado: transcrever custa alguns segundos de
    processador, e quem abrir a conversa depois já lê pronto."""
    usuario = g.usuario_atual
    conn = get_db()
    conversa = _carregar_conversa(conn, g.empresa_id, conversa_id)
    if not _pode_visualizar(usuario, conversa, conn):
        raise ApiError(_recusa_atribuida(conversa), status=403, codigo="sem_permissao")
    mensagem = conn.execute(
        "SELECT * FROM whatsapp_mensagens WHERE id = ? AND conversa_id = ?", (mensagem_id, conversa_id)
    ).fetchone()
    if mensagem is None:
        raise ApiError("Mensagem não encontrada.", status=404, codigo="nao_encontrado")
    # Já transcrita: devolve o que está guardado, sem refazer.
    if mensagem["transcricao_em"]:
        return jsonify({"transcricao": mensagem["transcricao"] or "", "de_cache": True})
    if mensagem["tipo"] != "audio":
        raise ApiError("Essa mensagem não é um áudio.", status=400)

    caminho = _caminho_do_anexo(mensagem["midia_url"])
    if caminho is None:
        raise ApiError("O arquivo deste áudio não está mais no servidor.", status=404, codigo="nao_encontrado")

    try:
        texto = transcricao.transcrever(caminho)
    except transcricao.TranscricaoIndisponivel as e:
        raise ApiError(str(e), status=503)
    except Exception:
        raise ApiError("Não consegui transcrever este áudio. Tente de novo em instantes.", status=500)

    conn.execute(
        "UPDATE whatsapp_mensagens SET transcricao = ?, transcricao_em = ? WHERE id = ?",
        (texto, _now_iso(), mensagem_id),
    )
    whatsapp_service.registrar_atividade(conn, usuario["id"], "audio_transcrito", texto[:120], conversa_id)
    return jsonify({"transcricao": texto, "de_cache": False})


@bp.post("/conversas/<int:conversa_id>/mensagens/<int:mensagem_id>/reenviar")
@requires_auth
def reenviar_mensagem(conversa_id, mensagem_id):
    """Reenvia uma mensagem nossa que falhou (ex.: WhatsApp caiu na hora),
    sem precisar escrever ou anexar de novo."""
    usuario = g.usuario_atual
    conn = get_db()
    conversa = _carregar_conversa(conn, g.empresa_id, conversa_id)
    if not _pode_agir(usuario, conversa):
        raise ApiError(_recusa_atribuida(conversa), status=403, codigo="sem_permissao")
    mensagem = conn.execute(
        "SELECT * FROM whatsapp_mensagens WHERE id = ? AND conversa_id = ?", (mensagem_id, conversa_id)
    ).fetchone()
    if mensagem is None:
        raise ApiError("Mensagem não encontrada.", status=404, codigo="nao_encontrado")
    if mensagem["direcao"] != "saida" or mensagem["status"] != "falhou":
        raise ApiError("Só é possível reenviar mensagens nossas que falharam.", status=400)
    config = whatsapp_service.obter_configuracao(conn, g.empresa_id)
    ok = whatsapp_service.reenviar_mensagem(conn, config, dict(mensagem))
    whatsapp_service.registrar_atividade(conn, usuario["id"], "mensagem_reenviada", conversa["telefone"], conversa_id)
    if not ok:
        raise ApiError("O reenvio falhou de novo. Tente em instantes.", status=502)
    return jsonify({"ok": True})


@bp.post("/conversas/<int:conversa_id>/mensagens/<int:mensagem_id>/reagir")
@requires_auth
def reagir_mensagem(conversa_id, mensagem_id):
    """Reage a uma mensagem com um emoji, como no WhatsApp.

    A reação vale nos dois sentidos: aparece no celular do cliente e fica
    guardada aqui, na própria mensagem. Emoji vazio tira a reação."""
    usuario = g.usuario_atual
    conn = get_db()
    conversa = _carregar_conversa(conn, g.empresa_id, conversa_id)
    if not _pode_agir(usuario, conversa):
        raise ApiError(_recusa_atribuida(conversa), status=403, codigo="sem_permissao")
    mensagem = conn.execute(
        "SELECT * FROM whatsapp_mensagens WHERE id = ? AND conversa_id = ?", (mensagem_id, conversa_id)
    ).fetchone()
    if mensagem is None:
        raise ApiError("Mensagem não encontrada.", status=404, codigo="nao_encontrado")
    emoji = ((request.get_json(silent=True) or {}).get("emoji") or "").strip()

    # Guarda primeiro: o cliente ver a reação é bom, mas o registro aqui
    # é o que a equipe usa. Se o WhatsApp recusar, a marca local fica e a
    # tela avisa — melhor que perder as duas coisas.
    conn.execute(
        "UPDATE whatsapp_mensagens SET reacao = ?, reacao_em = ? WHERE id = ?",
        (emoji or None, _now_iso() if emoji else None, mensagem_id),
    )
    enviada = False
    if mensagem["externo_id"]:
        try:
            whatsapp_service.reagir_mensagem(
                whatsapp_service.obter_configuracao(conn, g.empresa_id),
                conversa["telefone"], mensagem["externo_id"], emoji,
                minha=(mensagem["direcao"] == "saida"),
            )
            enviada = True
        except ApiError:
            enviada = False
    return jsonify({"ok": True, "emoji": emoji or None, "enviada_ao_cliente": enviada})


@bp.post("/conversas/<int:conversa_id>/sem-pendencia")
@requires_auth
def marcar_sem_pendencia(conversa_id):
    """"Vi, não precisa responder" — tira a conversa do alerta de atraso
    sem mandar mensagem.

    Existe porque o alerta considera pendente toda conversa em que o
    cliente falou por último, e isso obrigava o atendente a ter sempre a
    última palavra, mesmo diante de um "ok, obrigado". Fica registrado
    quem marcou: isso mexe no indicador de atraso, e sem registro seria
    um jeito silencioso de esconder demora.

    Se o cliente escrever de novo, a marca deixa de valer sozinha (ver a
    comparação com ultima_mensagem_em em listar_conversas_sla_estourado).
    """
    usuario = g.usuario_atual
    conn = get_db()
    conversa = _carregar_conversa(conn, g.empresa_id, conversa_id)
    if not _pode_agir(usuario, conversa):
        raise ApiError(_recusa_atribuida(conversa), status=403, codigo="sem_permissao")
    desmarcar = bool((request.get_json(silent=True) or {}).get("desmarcar"))
    if desmarcar:
        conn.execute("UPDATE whatsapp_conversas SET sem_pendencia_em = NULL, sem_pendencia_por = NULL WHERE id = ?",
                     (conversa_id,))
        return jsonify({"ok": True, "sem_pendencia": False})
    conn.execute(
        "UPDATE whatsapp_conversas SET sem_pendencia_em = ?, sem_pendencia_por = ? WHERE id = ?",
        (_now_iso(), usuario["id"], conversa_id),
    )
    whatsapp_service.registrar_atividade(conn, usuario["id"], "sem_pendencia", conversa["telefone"], conversa_id)
    return jsonify({"ok": True, "sem_pendencia": True})


@bp.post("/conversas/<int:conversa_id>/assumir")
@requires_auth
def assumir_conversa(conversa_id):
    """Pega uma conversa da fila (sem dono) para si. Se já tiver dono,
    só um admin pode 'assumir por cima' — qualquer outro usuário recebe
    409 (evita duas pessoas assumindo a mesma conversa da fila em uma
    corrida de cliques).

    Usuário comum só pode assumir uma conversa do PRÓPRIO setor — e só
    depois que ela já tem um setor definido (o cliente respondeu o menu,
    ou caiu no fallback). Enquanto não tem setor (ainda no meio do menu,
    ou o cliente nunca respondeu), só o admin consegue assumir — regra
    explícita pra evitar gente de qualquer área pegando conversa que
    ainda nem sabe pra onde vai."""
    usuario = g.usuario_atual
    conn = get_db()
    conversa = _carregar_conversa(conn, g.empresa_id, conversa_id)
    if conversa["atribuida_usuario_id"] is not None and not usuario["admin"]:
        raise ApiError(_recusa_atribuida(conversa, " Peça pra ela encaminhar, ou fale com um administrador."),
                       status=409, codigo="ja_atribuida")
    if not usuario["admin"]:
        if not conversa["menu_setor"] and not _esperou_demais_sem_menu(conn, conversa):
            raise ApiError(
                "Essa conversa acabou de chegar e o cliente ainda pode escolher o setor. "
                "Se ele não escolher, ela aparece na fila de todos em instantes.",
                status=403, codigo="sem_permissao")
        # Compara com TODOS os setores da pessoa: quem atende Televendas
        # e Financeiro pode assumir conversa dos dois. Antes olhava só o
        # setor principal e barrava o segundo.
        if conversa["menu_setor"] and conversa["menu_setor"] not in whatsapp_service.setores_do_usuario(conn, usuario["id"]):
            raise ApiError(
                f"Essa conversa é do setor {conversa['menu_setor']} — você só pode assumir conversas dos setores que atende.",
                status=403, codigo="sem_permissao")
    whatsapp_service.atribuir_conversa(conn, conversa_id, usuario["id"], usuario["id"])
    whatsapp_service.registrar_atividade(conn, usuario["id"], "conversa_assumida", conversa["telefone"], conversa_id)
    return jsonify({"ok": True})


@bp.put("/conversas/<int:conversa_id>/atribuir")
@requires_auth
def atribuir_conversa(conversa_id):
    """Encaminhar: o dono atual (ou um admin) manda a conversa para outro
    usuário — funciona direto da lista, sem precisar abrir a conversa
    (o dono anterior deixa de vê-la, o novo dono passa a ver)."""
    usuario = g.usuario_atual
    dados = request.get_json(silent=True) or {}
    conn = get_db()
    conversa = _carregar_conversa(conn, g.empresa_id, conversa_id)
    if not _pode_agir(usuario, conversa):
        raise ApiError("Só o responsável atual por esta conversa (ou um administrador) pode encaminhá-la.", status=403, codigo="sem_permissao")

    novo_usuario_id = dados.get("usuario_id")
    alvo = None
    if novo_usuario_id is not None:
        alvo = conn.execute(
            "SELECT * FROM usuarios WHERE id = ? AND ativo = 1 AND empresa_id = ?", (novo_usuario_id, g.empresa_id)
        ).fetchone()
        if alvo is None:
            raise ApiError("Usuário de destino não encontrado ou inativo.", status=400)

    whatsapp_service.atribuir_conversa(conn, conversa_id, novo_usuario_id, usuario["id"])
    descricao = f"{conversa['telefone']} -> {alvo['nome']}" if novo_usuario_id else f"{conversa['telefone']} -> fila"
    whatsapp_service.registrar_atividade(conn, usuario["id"], "conversa_encaminhada", descricao, conversa_id)
    return jsonify({"ok": True})


@bp.post("/conversas/<int:conversa_id>/fechar")
@requires_auth
def fechar_conversa(conversa_id):
    usuario = g.usuario_atual
    dados = request.get_json(silent=True) or {}
    resultado = dados.get("resultado")
    if resultado not in (None, "venda", "perdido"):
        raise ApiError("Resultado inválido — use 'venda', 'perdido' ou deixe em branco.", status=400)
    conn = get_db()
    conversa = _carregar_conversa(conn, g.empresa_id, conversa_id)
    if not _pode_agir(usuario, conversa):
        raise ApiError("Só o responsável por esta conversa (ou um administrador) pode encerrá-la.", status=403, codigo="sem_permissao")
    whatsapp_service.fechar_conversa(conn, conversa_id, resultado)
    whatsapp_service.registrar_atividade(conn, usuario["id"], "conversa_fechada", f"{conversa['telefone']}" + (f" ({resultado})" if resultado else ""), conversa_id)
    return jsonify({"ok": True})


@bp.post("/conversas/<int:conversa_id>/reabrir")
@requires_auth
def reabrir_conversa(conversa_id):
    usuario = g.usuario_atual
    conn = get_db()
    conversa = _carregar_conversa(conn, g.empresa_id, conversa_id)
    if not _pode_agir(usuario, conversa):
        raise ApiError("Só o responsável por esta conversa (ou um administrador) pode reabri-la.", status=403, codigo="sem_permissao")
    whatsapp_service.reabrir_conversa(conn, conversa_id)
    whatsapp_service.registrar_atividade(conn, usuario["id"], "conversa_reaberta", conversa["telefone"], conversa_id)
    return jsonify({"ok": True})


@bp.post("/conversas/<int:conversa_id>/arquivar")
@requires_auth
def arquivar_conversa(conversa_id):
    usuario = g.usuario_atual
    dados = request.get_json(silent=True) or {}
    arquivar = dados.get("arquivar", True)
    conn = get_db()
    conversa = _carregar_conversa(conn, g.empresa_id, conversa_id)
    if not _pode_agir(usuario, conversa):
        raise ApiError("Só o responsável por esta conversa (ou um administrador) pode arquivá-la.", status=403, codigo="sem_permissao")
    whatsapp_service.arquivar_conversa(conn, conversa_id, bool(arquivar))
    # Arquivar é o gesto de "terminei com este". Deixar a conversa aberta
    # depois disso significava que o cliente, ao voltar, caía direto no
    # atendimento antigo — sem passar pelo menu e sem ninguém saber que
    # ele voltou. Encerrar junto faz o próximo contato começar do zero.
    if arquivar and conversa["status"] == "aberta":
        whatsapp_service.fechar_conversa(conn, conversa_id)
        whatsapp_service.registrar_atividade(
            conn, usuario["id"], "conversa_fechada_ao_arquivar", conversa["telefone"], conversa_id
        )
    whatsapp_service.registrar_atividade(
        conn, usuario["id"], "conversa_arquivada" if arquivar else "conversa_desarquivada", conversa["telefone"], conversa_id
    )
    return jsonify({"ok": True})


@bp.delete("/conversas/<int:conversa_id>")
@requires_auth
def excluir_conversa(conversa_id):
    usuario = g.usuario_atual
    conn = get_db()
    conversa = _carregar_conversa(conn, g.empresa_id, conversa_id)
    if not _pode_agir(usuario, conversa):
        raise ApiError("Só o responsável por esta conversa (ou um administrador) pode excluí-la.", status=403, codigo="sem_permissao")
    whatsapp_service.excluir_conversa(conn, conversa_id)
    whatsapp_service.registrar_atividade(conn, usuario["id"], "conversa_excluida", conversa["telefone"], conversa_id)
    return jsonify({"ok": True})


# ============================================================
# DASHBOARD — admin
# ============================================================
@bp.get("/dashboard")
@requires_admin
def dashboard():
    conn = get_db()
    return jsonify(whatsapp_service.calcular_dashboard(conn, g.empresa_id))


@bp.post("/dashboard/resetar")
@requires_admin
def resetar_dashboard():
    """Zera os contadores do Dashboard a partir de agora — não apaga
    nenhuma conversa/mensagem real, só marca daqui pra frente."""
    conn = get_db()
    whatsapp_service.resetar_dashboard(conn, g.empresa_id)
    return jsonify({"ok": True})


@bp.get("/dashboard/mapa")
@requires_admin
def dashboard_mapa():
    conn = get_db()
    return jsonify(whatsapp_service.calcular_mapa_regioes(conn, g.empresa_id))


@bp.get("/dashboard/exportar")
@requires_admin
def exportar_dashboard():
    conn = get_db()
    painel = whatsapp_service.calcular_dashboard(conn, g.empresa_id)
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow([
        "Usuário", "Email", "Conversas atribuídas", "Conversas abertas", "Conversas fechadas",
        "Não lidas pendentes", "Mensagens enviadas", "Tempo médio 1ª resposta (min)",
        "Tempo médio resposta (min)", "Tempo médio atendimento (min)", "Avaliação média", "Total avaliações",
    ])
    for u in painel["usuarios"]:
        w.writerow([
            u["nome"], u["email"], u["conversas_atribuidas"], u["conversas_abertas"], u["conversas_fechadas"],
            u["nao_lidas_pendentes"], u["mensagens_enviadas"], u["tempo_medio_primeira_resposta_min"],
            u["tempo_medio_resposta_min"], u["tempo_medio_atendimento_min"], u["media_avaliacao"], u["total_avaliacoes"],
        ])
    conteudo = "﻿" + buf.getvalue()  # BOM — Excel no Windows abre acentuação certa com isso
    return Response(
        conteudo, mimetype="text/csv",
        headers={"Content-Disposition": f"attachment; filename=dashboard_{_now_iso()[:10]}.csv"},
    )


# ============================================================
# RASTRO DE ATIVIDADES — admin
# ============================================================
@bp.get("/atividades")
@requires_admin
def listar_atividades():
    usuario_id = request.args.get("usuario_id", type=int)
    conn = get_db()
    return jsonify(whatsapp_service.listar_atividades(conn, g.empresa_id, usuario_id))


# ============================================================
# RESUMO DA CONVERSA
# ============================================================
@bp.put("/conversas/<int:conversa_id>/resumo")
@requires_auth
def salvar_resumo(conversa_id):
    usuario = g.usuario_atual
    dados = request.get_json(silent=True) or {}
    conn = get_db()
    conversa = _carregar_conversa(conn, g.empresa_id, conversa_id)
    if not _pode_visualizar(usuario, conversa):
        raise ApiError(_recusa_atribuida(conversa), status=403, codigo="sem_permissao")
    whatsapp_service.salvar_resumo(conn, conversa_id, (dados.get("resumo") or "").strip() or None)
    return jsonify({"ok": True})


@bp.post("/conversas/<int:conversa_id>/atualizar-foto-contato")
@requires_auth
def atualizar_foto_contato(conversa_id):
    usuario = g.usuario_atual
    conn = get_db()
    conversa = _carregar_conversa(conn, g.empresa_id, conversa_id)
    if not _pode_visualizar(usuario, conversa):
        raise ApiError(_recusa_atribuida(conversa), status=403, codigo="sem_permissao")
    config = whatsapp_service.obter_configuracao(conn, g.empresa_id)
    foto_url = whatsapp_service.atualizar_foto_contato(conn, config, conversa["contato_id"], conversa["telefone"])
    return jsonify({"foto_url": foto_url})


@bp.post("/contatos/atualizar-fotos")
@requires_auth
@requires_admin
def atualizar_fotos_contatos():
    """Puxa de uma vez a foto de perfil de todo contato que ainda não
    tem. Útil logo depois de conectar um número: os contatos que já
    existiam foram criados sem foto (o WhatsApp estava fora do ar na
    hora), e sem isso eles só ganhariam foto na próxima mensagem."""
    conn = get_db()
    config = whatsapp_service.obter_configuracao(conn, g.empresa_id)
    if config.get("status_conexao") != "conectado":
        raise ApiError("Conecte um número do WhatsApp antes — sem conexão não dá pra consultar as fotos.", status=400)
    sem_foto = conn.execute(
        "SELECT id, telefone FROM whatsapp_contatos WHERE empresa_id = ? AND foto_url IS NULL ORDER BY id",
        (g.empresa_id,),
    ).fetchall()
    encontradas = 0
    for contato in sem_foto:
        if whatsapp_service.atualizar_foto_contato(conn, config, contato["id"], contato["telefone"]):
            encontradas += 1
    return jsonify({"consultados": len(sem_foto), "encontradas": encontradas})


# ============================================================
# NOTAS INTERNAS — nunca enviadas ao cliente, só visíveis pra equipe
# ============================================================
@bp.get("/conversas/<int:conversa_id>/notas")
@requires_auth
def listar_notas(conversa_id):
    usuario = g.usuario_atual
    conn = get_db()
    conversa = _carregar_conversa(conn, g.empresa_id, conversa_id)
    if not _pode_visualizar(usuario, conversa):
        raise ApiError(_recusa_atribuida(conversa), status=403, codigo="sem_permissao")
    return jsonify(whatsapp_service.listar_notas(conn, conversa_id))


@bp.post("/conversas/<int:conversa_id>/notas")
@requires_auth
def criar_nota(conversa_id):
    usuario = g.usuario_atual
    dados = request.get_json(silent=True) or {}
    texto = (dados.get("texto") or "").strip()
    if not texto:
        raise ApiError("Informe o texto da nota.", status=400)
    conn = get_db()
    conversa = _carregar_conversa(conn, g.empresa_id, conversa_id)
    if not _pode_visualizar(usuario, conversa):
        raise ApiError(_recusa_atribuida(conversa), status=403, codigo="sem_permissao")
    whatsapp_service.criar_nota(conn, conversa_id, usuario["id"], texto)
    return jsonify({"ok": True}), 201


# ============================================================
# ETIQUETAS (TAGS) LIVRES
# ============================================================
# Nenhuma rota daqui é de admin: a etiqueta é de quem a criou, e cada
# um cuida das suas. Um admin também não mexe nas etiquetas dos outros —
# é anotação pessoal, não configuração da empresa.
@bp.get("/tags")
@requires_auth
def listar_tags():
    conn = get_db()
    return jsonify(whatsapp_service.listar_tags(conn, g.empresa_id, g.usuario_atual["id"]))


@bp.post("/tags")
@requires_auth
def criar_tag():
    dados = request.get_json(silent=True) or {}
    nome = (dados.get("nome") or "").strip()
    if not nome:
        raise ApiError("Informe o nome da etiqueta.", status=400)
    conn = get_db()
    return jsonify(whatsapp_service.criar_tag(conn, g.empresa_id, g.usuario_atual["id"], nome, dados.get("cor"))), 201


@bp.put("/tags/<int:tag_id>")
@requires_auth
def editar_tag(tag_id):
    """Renomeia a etiqueta e/ou troca a cor. Como a conversa guarda o ID
    da etiqueta (e não uma cópia do nome), renomear aqui muda o nome em
    todas as conversas de uma vez — não é preciso reetiquetar nada.

    Só o dono edita: a etiqueta é anotação pessoal dele."""
    conn = get_db()
    dados = request.get_json(silent=True) or {}
    nome = (dados.get("nome") or "").strip()
    cor = (dados.get("cor") or "").strip()
    if not nome:
        raise ApiError("Informe o nome da etiqueta.", status=400)
    existe = conn.execute(
        "SELECT 1 FROM whatsapp_tags WHERE id = ? AND empresa_id = ? AND usuario_id = ?",
        (tag_id, g.empresa_id, g.usuario_atual["id"]),
    ).fetchone()
    if existe is None:
        raise ApiError("Etiqueta não encontrada.", status=404, codigo="nao_encontrado")
    duplicada = conn.execute(
        "SELECT 1 FROM whatsapp_tags WHERE empresa_id = ? AND usuario_id = ? AND lower(nome) = lower(?) AND id != ?",
        (g.empresa_id, g.usuario_atual["id"], nome, tag_id),
    ).fetchone()
    if duplicada:
        raise ApiError("Você já tem uma etiqueta com esse nome.", status=409, codigo="nome_duplicado")
    if cor:
        conn.execute("UPDATE whatsapp_tags SET nome = ?, cor = ? WHERE id = ?", (nome, cor, tag_id))
    else:
        conn.execute("UPDATE whatsapp_tags SET nome = ? WHERE id = ?", (nome, tag_id))
    return jsonify(dict(conn.execute("SELECT * FROM whatsapp_tags WHERE id = ?", (tag_id,)).fetchone()))


@bp.get("/tags/contagem")
@requires_auth
def contar_por_tag():
    """Quantas conversas ativas cada etiqueta tem — é o número que
    aparece ao lado dela no filtro, pra dar noção antes de clicar."""
    conn = get_db()
    rows = conn.execute(
        """
        SELECT t.id, COUNT(c.id) AS total
        FROM whatsapp_tags t
        LEFT JOIN whatsapp_conversa_tags ct2 ON ct2.tag_id = t.id
        LEFT JOIN whatsapp_conversas c ON c.id = ct2.conversa_id
             AND c.excluida_em IS NULL AND c.arquivada = 0
        WHERE t.empresa_id = ? AND t.usuario_id = ?
        GROUP BY t.id
        """,
        (g.empresa_id, g.usuario_atual["id"]),
    ).fetchall()
    return jsonify({str(r["id"]): r["total"] for r in rows})


@bp.delete("/tags/<int:tag_id>")
@requires_auth
def excluir_tag(tag_id):
    conn = get_db()
    if not whatsapp_service.excluir_tag(conn, g.empresa_id, g.usuario_atual["id"], tag_id):
        raise ApiError("Etiqueta não encontrada.", status=404, codigo="nao_encontrado")
    return jsonify({"ok": True})


@bp.put("/conversas/<int:conversa_id>/tags")
@requires_auth
def definir_tags_conversa(conversa_id):
    usuario = g.usuario_atual
    dados = request.get_json(silent=True) or {}
    conn = get_db()
    conversa = _carregar_conversa(conn, g.empresa_id, conversa_id)
    if not _pode_visualizar(usuario, conversa):
        raise ApiError(_recusa_atribuida(conversa), status=403, codigo="sem_permissao")
    whatsapp_service.definir_tags_da_conversa(conn, g.empresa_id, g.usuario_atual["id"], conversa_id, dados.get("tag_ids") or [])
    return jsonify({"ok": True})


# ============================================================
# RESPOSTAS PRONTAS
# ============================================================
# ============================================================
# FIGURINHAS E EMOJIS — o banco cresce com o uso: o atendente guarda a
# figurinha que o cliente mandou e ela fica disponível pra todo mundo da
# empresa reusar depois.
# ============================================================
@bp.get("/figurinhas")
@requires_auth
def listar_figurinhas():
    conn = get_db()
    rows = conn.execute(
        "SELECT id, midia_url, descricao FROM whatsapp_figurinhas WHERE empresa_id = ? ORDER BY id DESC LIMIT 200",
        (g.empresa_id,),
    ).fetchall()
    return jsonify([dict(r) for r in rows])


@bp.post("/figurinhas")
@requires_auth
def salvar_figurinha():
    """Guarda no banco da empresa uma figurinha/imagem que já está numa
    conversa. Só aceita URL dos nossos próprios anexos — sem isso daria
    pra cadastrar qualquer endereço da internet e o sistema passaria a
    servir conteúdo de fora como se fosse nosso."""
    dados = request.get_json(silent=True) or {}
    midia_url = (dados.get("midia_url") or "").strip()
    if not midia_url.startswith("/api/v1/whatsapp/uploads/"):
        raise ApiError("Só dá pra salvar figurinha que veio de uma conversa.", status=400)
    conn = get_db()
    ja = conn.execute(
        "SELECT id FROM whatsapp_figurinhas WHERE empresa_id = ? AND midia_url = ?", (g.empresa_id, midia_url)
    ).fetchone()
    if ja:
        return jsonify({"ok": True, "id": ja["id"], "ja_existia": True})
    cur = conn.execute(
        "INSERT INTO whatsapp_figurinhas (empresa_id, midia_url, descricao, criado_por, criado_em) VALUES (?, ?, ?, ?, ?)",
        (g.empresa_id, midia_url, (dados.get("descricao") or "").strip() or None,
         g.usuario_atual["id"], whatsapp_service._now_iso()),
    )
    return jsonify({"ok": True, "id": cur.lastrowid}), 201


@bp.delete("/figurinhas/<int:figurinha_id>")
@requires_auth
def excluir_figurinha(figurinha_id):
    conn = get_db()
    cur = conn.execute(
        "DELETE FROM whatsapp_figurinhas WHERE id = ? AND empresa_id = ?", (figurinha_id, g.empresa_id)
    )
    if cur.rowcount == 0:
        raise ApiError("Figurinha não encontrada.", status=404, codigo="nao_encontrado")
    return jsonify({"ok": True})


@bp.post("/conversas/<int:conversa_id>/figurinha")
@requires_auth
def enviar_figurinha_conversa(conversa_id):
    usuario = g.usuario_atual
    conn = get_db()
    conversa = _carregar_conversa(conn, g.empresa_id, conversa_id)
    if not _pode_agir(usuario, conversa):
        raise ApiError(_recusa_atribuida(conversa), status=403, codigo="sem_permissao")

    dados = request.get_json(silent=True) or {}
    figurinha = conn.execute(
        "SELECT midia_url FROM whatsapp_figurinhas WHERE id = ? AND empresa_id = ?",
        (dados.get("figurinha_id"), g.empresa_id),
    ).fetchone()
    if figurinha is None:
        raise ApiError("Figurinha não encontrada.", status=404, codigo="nao_encontrado")

    if conversa["atribuida_usuario_id"] is None:
        whatsapp_service.atribuir_conversa(conn, conversa_id, usuario["id"], usuario["id"])

    config = whatsapp_service.obter_configuracao(conn, g.empresa_id)
    try:
        url_completa = whatsapp_service.url_publica(config, figurinha["midia_url"])
        externo_id = whatsapp_service.enviar_figurinha(config, conversa["telefone"], url_completa)
        status_msg, erro = "enviada", None
    except ApiError as e:
        externo_id, status_msg, erro = None, "falhou", e.mensagem

    agora = whatsapp_service._now_iso()
    conn.execute(
        """
        INSERT INTO whatsapp_mensagens (conversa_id, usuario_id, direcao, tipo, texto, midia_url, externo_id, status, erro, criado_em)
        VALUES (?, ?, 'saida', 'figurinha', NULL, ?, ?, ?, ?, ?)
        """,
        (conversa_id, usuario["id"], figurinha["midia_url"], externo_id, status_msg, erro, agora),
    )
    conn.execute(
        "UPDATE whatsapp_conversas SET ultima_mensagem_em = ?, ultima_mensagem_preview = ?, "
        "ultima_msg_operador_em = ?, proximo_contato_em = NULL, followup_adiado_ate = NULL WHERE id = ?",
        (agora, "🧩 Figurinha", agora, conversa_id),
    )
    return jsonify({"ok": status_msg == "enviada", "aviso": erro}), 201


@bp.get("/emojis")
@requires_auth
def listar_emojis():
    conn = get_db()
    rows = conn.execute(
        "SELECT id, emoji FROM whatsapp_emojis WHERE empresa_id = ? ORDER BY id DESC LIMIT 200", (g.empresa_id,)
    ).fetchall()
    return jsonify([dict(r) for r in rows])


@bp.post("/emojis")
@requires_auth
def salvar_emoji():
    dados = request.get_json(silent=True) or {}
    emoji = (dados.get("emoji") or "").strip()
    if not emoji:
        raise ApiError("Informe o emoji.", status=400)
    if len(emoji) > 16:
        raise ApiError("Isso não parece um emoji — cole apenas um.", status=400)
    conn = get_db()
    ja = conn.execute(
        "SELECT id FROM whatsapp_emojis WHERE empresa_id = ? AND emoji = ?", (g.empresa_id, emoji)
    ).fetchone()
    if ja:
        return jsonify({"ok": True, "id": ja["id"], "ja_existia": True})
    cur = conn.execute(
        "INSERT INTO whatsapp_emojis (empresa_id, emoji, criado_por, criado_em) VALUES (?, ?, ?, ?)",
        (g.empresa_id, emoji, g.usuario_atual["id"], whatsapp_service._now_iso()),
    )
    return jsonify({"ok": True, "id": cur.lastrowid}), 201


@bp.delete("/emojis/<int:emoji_id>")
@requires_auth
def excluir_emoji(emoji_id):
    conn = get_db()
    cur = conn.execute("DELETE FROM whatsapp_emojis WHERE id = ? AND empresa_id = ?", (emoji_id, g.empresa_id))
    if cur.rowcount == 0:
        raise ApiError("Emoji não encontrado.", status=404, codigo="nao_encontrado")
    return jsonify({"ok": True})


@bp.get("/respostas-prontas")
@requires_auth
def listar_respostas_prontas():
    conn = get_db()
    return jsonify(whatsapp_service.listar_respostas_prontas(conn, g.empresa_id))


@bp.post("/respostas-prontas")
@requires_auth
def criar_resposta_pronta():
    usuario = g.usuario_atual
    dados = request.get_json(silent=True) or {}
    atalho = (dados.get("atalho") or "").strip().lower().lstrip("/")
    titulo = (dados.get("titulo") or "").strip()
    texto = (dados.get("texto") or "").strip()
    if not atalho or not titulo or not texto:
        raise ApiError("Informe atalho, título e texto.", status=400)
    conn = get_db()
    resposta = whatsapp_service.criar_resposta_pronta(conn, g.empresa_id, atalho, titulo, texto, usuario["id"])
    return jsonify(resposta), 201


@bp.delete("/respostas-prontas/<int:resposta_id>")
@requires_auth
def excluir_resposta_pronta(resposta_id):
    conn = get_db()
    if not whatsapp_service.excluir_resposta_pronta(conn, g.empresa_id, resposta_id):
        raise ApiError("Resposta pronta não encontrada.", status=404, codigo="nao_encontrado")
    return jsonify({"ok": True})


# ============================================================
# MENSAGENS AGENDADAS
# ============================================================
@bp.get("/agendadas")
@requires_auth
def listar_todas_agendadas():
    """Visão global (tela 'Agendamentos') — todas as mensagens
    agendadas pendentes do usuário, ou de todo mundo se admin pedir
    ?todos=1. Diferente de /conversas/<id>/agendadas, que é só de uma
    conversa (usada dentro do chat)."""
    usuario = g.usuario_atual
    todos = request.args.get("todos") == "1"
    if todos and not usuario["admin"]:
        raise ApiError("Só um administrador pode ver os agendamentos de todos.", status=403, codigo="sem_permissao")
    conn = get_db()
    return jsonify(whatsapp_service.listar_todas_agendadas(conn, g.empresa_id, None if todos else usuario["id"]))


@bp.get("/conversas/<int:conversa_id>/agendadas")
@requires_auth
def listar_agendadas(conversa_id):
    usuario = g.usuario_atual
    conn = get_db()
    conversa = _carregar_conversa(conn, g.empresa_id, conversa_id)
    if not _pode_visualizar(usuario, conversa):
        raise ApiError(_recusa_atribuida(conversa), status=403, codigo="sem_permissao")
    return jsonify(whatsapp_service.listar_agendadas(conn, conversa_id))


@bp.post("/conversas/<int:conversa_id>/agendar")
@requires_auth
def agendar_mensagem(conversa_id):
    usuario = g.usuario_atual
    # Aceita tanto JSON puro (só texto) quanto multipart (com anexo opcional)
    # — o mesmo endpoint serve os dois casos pra não duplicar rota.
    eh_multipart = request.content_type and "multipart/form-data" in request.content_type
    dados = request.form if eh_multipart else (request.get_json(silent=True) or {})
    texto = (dados.get("texto") or "").strip()
    agendado_para = dados.get("agendado_para")
    if not texto:
        raise ApiError("Informe o texto da mensagem.", status=400)
    if not agendado_para:
        raise ApiError("Informe a data/hora do agendamento.", status=400)
    if agendado_para <= whatsapp_service._now_iso():
        raise ApiError("A data/hora do agendamento precisa ser no futuro.", status=400)

    conn = get_db()
    conversa = _carregar_conversa(conn, g.empresa_id, conversa_id)
    if not _pode_agir(usuario, conversa):
        raise ApiError(_recusa_atribuida(conversa), status=403, codigo="sem_permissao")

    tipo, midia_url, nome_arquivo = "texto", None, None
    arquivo = request.files.get("arquivo") if eh_multipart else None
    if arquivo and arquivo.filename:
        dados_bytes = arquivo.read()
        if len(dados_bytes) > MAX_ANEXO_MB * 1024 * 1024:
            raise ApiError(f"Arquivo maior que o limite de {MAX_ANEXO_MB}MB.", status=400)
        tipo_forcado = request.form.get("tipo")
        tipo = tipo_forcado if tipo_forcado in EXTENSOES_TIPO else _classificar_tipo(arquivo.filename)
        os.makedirs(PASTA_UPLOADS, exist_ok=True)
        nome_seguro = f"{secrets.token_hex(8)}_{secure_filename(arquivo.filename)}"
        with open(os.path.join(PASTA_UPLOADS, nome_seguro), "wb") as f:
            f.write(dados_bytes)
        midia_url = f"/api/v1/whatsapp/uploads/{nome_seguro}"
        nome_arquivo = arquivo.filename

    agendada = whatsapp_service.agendar_mensagem(conn, conversa_id, texto, agendado_para, usuario["id"], tipo, midia_url, nome_arquivo)
    whatsapp_service.registrar_atividade(conn, usuario["id"], "mensagem_agendada", f"para {agendado_para}", conversa_id)
    return jsonify(agendada), 201


def _agendada_da_empresa(conn, agendada_id, empresa_id):
    """Confirma que o agendamento é desta empresa antes de deixar mexer
    nele — senão dava pra cancelar/editar por ID o agendamento de outra.

    LEFT JOIN nos dois lados de propósito: o agendamento aponta pra uma
    conversa de cliente OU pra uma interna, nunca as duas. Com JOIN
    comum, todo agendamento do chat interno dava "não encontrado" — era
    impossível cancelá-los.
    """
    return conn.execute(
        """
        SELECT a.* FROM whatsapp_mensagens_agendadas a
        LEFT JOIN whatsapp_conversas c ON c.id = a.conversa_id
        LEFT JOIN whatsapp_contatos ct ON ct.id = c.contato_id
        LEFT JOIN chat_interno_conversas ci ON ci.id = a.chat_interno_conversa_id
        JOIN usuarios u ON u.id = a.criado_por
        WHERE a.id = ? AND (ct.empresa_id = ? OR (ci.id IS NOT NULL AND u.empresa_id = ?))
        """,
        (agendada_id, empresa_id, empresa_id),
    ).fetchone()


@bp.delete("/agendadas/<int:agendada_id>")
@requires_auth
def cancelar_agendada(agendada_id):
    usuario = g.usuario_atual
    conn = get_db()
    if _agendada_da_empresa(conn, agendada_id, g.empresa_id) is None:
        raise ApiError("Agendamento não encontrado.", status=404, codigo="nao_encontrado")
    whatsapp_service.cancelar_agendada(conn, agendada_id)
    whatsapp_service.registrar_atividade(conn, usuario["id"], "agendamento_cancelado")
    return jsonify({"ok": True})


@bp.put("/agendadas/<int:agendada_id>")
@requires_auth
def editar_agendada(agendada_id):
    """Muda o texto e/ou a hora de um agendamento que ainda não saiu.
    Depois de enviado não tem o que editar — a mensagem já está no
    celular de quem recebeu."""
    usuario = g.usuario_atual
    conn = get_db()
    agendada = _agendada_da_empresa(conn, agendada_id, g.empresa_id)
    if agendada is None:
        raise ApiError("Agendamento não encontrado.", status=404, codigo="nao_encontrado")
    if agendada["status"] != "pendente":
        raise ApiError("Esse agendamento já foi enviado — não dá mais pra editar.", status=400)
    if agendada["criado_por"] != usuario["id"] and not usuario["admin"]:
        raise ApiError("Só quem agendou (ou um administrador) pode editar.", status=403, codigo="sem_permissao")
    dados = request.get_json(silent=True) or {}
    texto = (dados.get("texto") or "").strip()
    quando = (dados.get("agendado_para") or "").strip()
    if not quando:
        raise ApiError("Informe a data e a hora.", status=400)
    # Anexo agendado não exige texto — ali o texto é só legenda.
    if not texto and agendada["tipo"] == "texto":
        raise ApiError("Escreva a mensagem.", status=400)
    conn.execute(
        "UPDATE whatsapp_mensagens_agendadas SET texto = ?, agendado_para = ? WHERE id = ?",
        (texto or None, quando, agendada_id),
    )
    whatsapp_service.registrar_atividade(conn, usuario["id"], "agendamento_editado", (texto or "")[:120])
    return jsonify({"ok": True})


# ============================================================
# LEMBRETES DE RETORNO
# ============================================================
@bp.get("/lembretes")
@requires_auth
def listar_lembretes():
    usuario = g.usuario_atual
    todos = request.args.get("todos") == "1"
    if todos and not usuario["admin"]:
        raise ApiError("Só um administrador pode ver os lembretes de todos.", status=403, codigo="sem_permissao")
    conn = get_db()
    return jsonify(whatsapp_service.listar_lembretes(conn, g.empresa_id, None if todos else usuario["id"]))


@bp.post("/conversas/<int:conversa_id>/lembretes")
@requires_auth
def criar_lembrete(conversa_id):
    usuario = g.usuario_atual
    dados = request.get_json(silent=True) or {}
    lembrar_em = dados.get("lembrar_em")
    if not lembrar_em:
        raise ApiError("Informe a data/hora do lembrete.", status=400)
    conn = get_db()
    conversa = _carregar_conversa(conn, g.empresa_id, conversa_id)
    if not _pode_visualizar(usuario, conversa):
        raise ApiError(_recusa_atribuida(conversa), status=403, codigo="sem_permissao")
    # Por padrão o lembrete é pra quem está criando; um admin pode
    # delegar pra outro usuário passando usuario_id.
    usuario_alvo = dados.get("usuario_id") or usuario["id"]
    if usuario_alvo != usuario["id"]:
        if not usuario["admin"]:
            raise ApiError("Só um administrador pode criar lembrete para outro usuário.", status=403, codigo="sem_permissao")
        alvo = conn.execute("SELECT 1 FROM usuarios WHERE id = ? AND empresa_id = ?", (usuario_alvo, g.empresa_id)).fetchone()
        if alvo is None:
            raise ApiError("Usuário não encontrado.", status=400)
    lembrete = whatsapp_service.criar_lembrete(conn, conversa_id, usuario_alvo, dados.get("texto") or None, lembrar_em, usuario["id"])
    whatsapp_service.registrar_atividade(conn, usuario["id"], "lembrete_criado", f"para {lembrar_em}", conversa_id)
    return jsonify(lembrete), 201


def _lembrete_da_empresa(conn, lembrete_id, empresa_id):
    """Mesmo cuidado (e mesma correção) de _agendada_da_empresa: com JOIN
    comum, lembrete de conversa interna nunca era encontrado, e por isso
    não dava pra concluí-lo."""
    return conn.execute(
        """
        SELECT l.* FROM whatsapp_lembretes l
        LEFT JOIN whatsapp_conversas c ON c.id = l.conversa_id
        LEFT JOIN whatsapp_contatos ct ON ct.id = c.contato_id
        LEFT JOIN chat_interno_conversas ci ON ci.id = l.chat_interno_conversa_id
        JOIN usuarios u ON u.id = l.usuario_id
        WHERE l.id = ? AND (ct.empresa_id = ? OR (ci.id IS NOT NULL AND u.empresa_id = ?))
        """,
        (lembrete_id, empresa_id, empresa_id),
    ).fetchone()


@bp.post("/lembretes/<int:lembrete_id>/concluir")
@requires_auth
def concluir_lembrete(lembrete_id):
    usuario = g.usuario_atual
    conn = get_db()
    if _lembrete_da_empresa(conn, lembrete_id, g.empresa_id) is None:
        raise ApiError("Lembrete não encontrado.", status=404, codigo="nao_encontrado")
    whatsapp_service.concluir_lembrete(conn, lembrete_id)
    whatsapp_service.registrar_atividade(conn, usuario["id"], "lembrete_concluido")
    return jsonify({"ok": True})


@bp.put("/lembretes/<int:lembrete_id>")
@requires_auth
def adiar_lembrete(lembrete_id):
    """Prorroga o lembrete pra outra hora. Ele continua pendente até
    alguém concluir — adiar nunca faz um lembrete sumir sozinho."""
    usuario = g.usuario_atual
    conn = get_db()
    lembrete = _lembrete_da_empresa(conn, lembrete_id, g.empresa_id)
    if lembrete is None:
        raise ApiError("Lembrete não encontrado.", status=404, codigo="nao_encontrado")
    if lembrete["usuario_id"] != usuario["id"] and not usuario["admin"]:
        raise ApiError("Esse lembrete é de outra pessoa.", status=403, codigo="sem_permissao")
    dados = request.get_json(silent=True) or {}
    quando = (dados.get("lembrar_em") or "").strip()
    if not quando:
        raise ApiError("Informe a nova data e hora.", status=400)
    texto = dados.get("texto")
    if texto is None:
        conn.execute("UPDATE whatsapp_lembretes SET lembrar_em = ? WHERE id = ?", (quando, lembrete_id))
    else:
        conn.execute(
            "UPDATE whatsapp_lembretes SET lembrar_em = ?, texto = ? WHERE id = ?",
            (quando, (texto or "").strip() or None, lembrete_id),
        )
    whatsapp_service.registrar_atividade(conn, usuario["id"], "lembrete_adiado", quando)
    return jsonify({"ok": True})


# ============================================================
# ANEXOS (imagem/vídeo/documento/áudio)
# ============================================================
@bp.post("/conversas/<int:conversa_id>/anexo")
@requires_auth
def enviar_anexo(conversa_id):
    usuario = g.usuario_atual
    conn = get_db()
    conversa = _carregar_conversa(conn, g.empresa_id, conversa_id)
    if not _pode_agir(usuario, conversa):
        raise ApiError(_recusa_atribuida(conversa, " Encaminhe para si mesmo antes de responder."), status=403, codigo="sem_permissao")

    arquivo = request.files.get("arquivo")
    if not arquivo or not arquivo.filename:
        raise ApiError("Nenhum arquivo enviado.", status=400)

    dados_bytes = arquivo.read()
    if len(dados_bytes) > MAX_ANEXO_MB * 1024 * 1024:
        raise ApiError(f"Arquivo maior que o limite de {MAX_ANEXO_MB}MB.", status=400)

    # A gravação de áudio do navegador manda tipo="audio" explicitamente
    # — o nome do arquivo sozinho (ex.: "audio.webm") não dá pra
    # distinguir de um vídeo .webm anexado manualmente, já que o
    # MediaRecorder grava áudio dentro de um contêiner webm.
    tipo_forcado = request.form.get("tipo")
    tipo = tipo_forcado if tipo_forcado in EXTENSOES_TIPO else _classificar_tipo(arquivo.filename)
    legenda = (request.form.get("legenda") or "").strip() or None

    os.makedirs(PASTA_UPLOADS, exist_ok=True)
    nome_seguro = f"{secrets.token_hex(8)}_{secure_filename(arquivo.filename)}"
    with open(os.path.join(PASTA_UPLOADS, nome_seguro), "wb") as f:
        f.write(dados_bytes)
    midia_url = f"/api/v1/whatsapp/uploads/{nome_seguro}"

    if conversa["atribuida_usuario_id"] is None:
        whatsapp_service.atribuir_conversa(conn, conversa_id, usuario["id"], usuario["id"])

    config = whatsapp_service.obter_configuracao(conn, g.empresa_id)
    agora = whatsapp_service._now_iso()
    try:
        url_completa = whatsapp_service.url_publica(config, midia_url)
        externo_id = whatsapp_service.enviar_midia(config, conversa["telefone"], tipo, url_completa, arquivo.filename, legenda)
        status_msg, erro = "enviada", None
    except ApiError as e:
        externo_id, status_msg, erro = None, "falhou", e.mensagem

    cur = conn.execute(
        """
        INSERT INTO whatsapp_mensagens (conversa_id, direcao, tipo, texto, midia_url, externo_id, usuario_id, status, erro, criado_em)
        VALUES (?, 'saida', ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (conversa_id, tipo, legenda, midia_url, externo_id, usuario["id"], status_msg, erro, agora),
    )
    conn.execute(
        "UPDATE whatsapp_conversas SET status = 'aberta', fechada_em = NULL, ultima_mensagem_em = ?, ultima_mensagem_preview = ?, "
        "ultima_msg_operador_em = ?, proximo_contato_em = NULL, followup_adiado_ate = NULL WHERE id = ?",
        (agora, f"📎 {legenda or arquivo.filename}"[:120], agora, conversa_id),
    )
    mensagem = dict(conn.execute("SELECT * FROM whatsapp_mensagens WHERE id = ?", (cur.lastrowid,)).fetchone())
    whatsapp_service.registrar_atividade(conn, usuario["id"], "anexo_enviado", arquivo.filename, conversa_id)
    if status_msg == "falhou":
        raise ApiError(f"Anexo registrado, mas o envio falhou: {erro}", status=502)
    return jsonify(mensagem), 201


PASTA_MARCA = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "data", "marca")
EXTENSOES_LOGO = {"jpg", "jpeg", "png", "gif", "webp", "svg"}
MAX_LOGO_MB = 3


@bp.post("/configuracao/logo")
@requires_admin
def enviar_logo():
    """Troca a logo que aparece na tela de login. Guardada em data/ (não
    junto do código) pra não ser apagada nas atualizações do sistema."""
    arquivo = request.files.get("logo")
    if not arquivo or not arquivo.filename:
        raise ApiError("Nenhuma imagem enviada.", status=400)
    ext = arquivo.filename.rsplit(".", 1)[-1].lower() if "." in arquivo.filename else ""
    if ext not in EXTENSOES_LOGO:
        raise ApiError("Formato não suportado. Use png, jpg, gif, webp ou svg.", status=400)
    dados_bytes = arquivo.read()
    if len(dados_bytes) > MAX_LOGO_MB * 1024 * 1024:
        raise ApiError(f"Imagem maior que o limite de {MAX_LOGO_MB}MB.", status=400)

    conn = get_db()
    anterior = whatsapp_service.obter_configuracao(conn, g.empresa_id).get("logo_url")

    os.makedirs(PASTA_MARCA, exist_ok=True)
    nome_seguro = f"{secrets.token_hex(8)}_{secure_filename(arquivo.filename)}"
    with open(os.path.join(PASTA_MARCA, nome_seguro), "wb") as f:
        f.write(dados_bytes)
    url = f"/api/v1/whatsapp/marca/{nome_seguro}"
    conn.execute("UPDATE configuracoes_whatsapp SET logo_url = ? WHERE empresa_id = ?", (url, g.empresa_id))

    if anterior:  # não deixa lixo acumulando a cada troca
        antigo = os.path.join(PASTA_MARCA, os.path.basename(anterior))
        if os.path.isfile(antigo):
            try:
                os.remove(antigo)
            except OSError:
                pass
    return jsonify({"logo_url": url})


@bp.delete("/configuracao/logo")
@requires_admin
def remover_logo():
    """Volta pra logo padrão do sistema."""
    conn = get_db()
    atual = whatsapp_service.obter_configuracao(conn, g.empresa_id).get("logo_url")
    conn.execute("UPDATE configuracoes_whatsapp SET logo_url = NULL WHERE empresa_id = ?", (g.empresa_id,))
    if atual:
        caminho = os.path.join(PASTA_MARCA, os.path.basename(atual))
        if os.path.isfile(caminho):
            try:
                os.remove(caminho)
            except OSError:
                pass
    return jsonify({"ok": True})


@bp.get("/marca/<path:nome_arquivo>")
def baixar_logo(nome_arquivo):
    """Sem @requires_auth de propósito: a logo aparece na tela de login,
    ou seja, antes de existir sessão. É a identidade visual da empresa,
    não é dado sigiloso."""
    resp = send_from_directory(PASTA_MARCA, nome_arquivo)
    resp.headers["X-Content-Type-Options"] = "nosniff"
    resp.headers["Content-Security-Policy"] = "sandbox; default-src 'none'"
    return resp


@bp.get("/uploads/<path:nome_arquivo>")
def baixar_anexo(nome_arquivo):
    """Deliberadamente SEM @requires_auth: isto é servido por <img src>
    e <a href> normais (imagem inline / link de download na bolha da
    conversa), e nem um nem outro consegue mandar o header Authorization
    que o resto da API exige — um <img>/<a> comum do navegador não anexa
    headers customizados. O controle de acesso aqui é o próprio nome do
    arquivo: cada upload ganha um prefixo aleatório de 16 hex (64 bits,
    ver secrets.token_hex(8) em enviar_anexo) — impossível de adivinhar
    e nunca listado em lugar nenhum, só aparece dentro de uma mensagem
    que a pessoa já tinha permissão de ver.

    IMPORTANTE (segurança): só imagem/vídeo/áudio pode abrir dentro da
    página. Qualquer outro arquivo sai como download forçado. Sem isso,
    um cliente podia mandar um .html com script dentro pelo WhatsApp; ao
    clicar no anexo, o navegador executaria esse script NO NOSSO
    endereço, com acesso à sessão do atendente (roubo de conta). O
    cabeçalho de sandbox e o nosniff cobrem o resto."""
    # PDF entra na lista do que abre dentro da página: é o documento que
    # mais chega no atendimento, e obrigar a baixar cada um só pra dar
    # uma olhada enche a pasta de downloads de arquivo que ninguém
    # queria guardar.
    #
    # Continua valendo a regra de segurança: só formatos que o navegador
    # exibe sem executar nada. Nada de .html ou .svg, que podem trazer
    # script dentro — clicar num deles rodaria esse script NO NOSSO
    # endereço, com acesso à sessão do atendente. O sandbox do CSP
    # abaixo é a segunda barreira, não a única.
    extensao = nome_arquivo.rsplit(".", 1)[-1].lower() if "." in nome_arquivo else ""
    inline = _classificar_tipo(nome_arquivo) in ("imagem", "video", "audio") or extensao == "pdf"
    resp = send_from_directory(PASTA_UPLOADS, nome_arquivo, as_attachment=not inline)
    resp.headers["X-Content-Type-Options"] = "nosniff"
    resp.headers["Content-Security-Policy"] = "sandbox; default-src 'none'"
    return resp


# ============================================================
# WEBHOOK DE ENTRADA — chamado pela Evolution API, sem JWT; autenticado
# só pelo segredo no caminho da URL.
# ============================================================
@bp.post("/webhook/<segredo>")
def webhook(segredo):
    """Sem JWT — a única autenticação é o segredo no caminho da URL, e é
    justamente esse segredo que diz de qual EMPRESA é este webhook (cada
    empresa tem o seu próprio, gerado em salvar_configuracao). Por isso a
    busca é pelo segredo, não por um empresa_id fixo — não tem como saber
    de qual empresa é antes de achar a config que bate com o segredo."""
    conn = get_db()
    config_row = conn.execute("SELECT * FROM configuracoes_whatsapp WHERE webhook_segredo = ?", (segredo,)).fetchone()
    if config_row is None:
        raise ApiError("Segredo de webhook inválido.", status=403, codigo="sem_permissao")
    config = dict(config_row)

    payload = request.get_json(silent=True) or {}
    resultado = whatsapp_service.processar_evento_webhook(conn, config, payload)
    return jsonify(resultado)
