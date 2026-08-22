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
import os
import re
import secrets

from flask import Blueprint, Response, g, jsonify, request, send_from_directory
from werkzeug.utils import secure_filename

from .. import whatsapp_service
from ..context import ApiError, get_db, requires_admin, requires_auth

bp = Blueprint("whatsapp", __name__, url_prefix="/api/v1/whatsapp")

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
def _conversa_para_json(row, tags=None):
    d = dict(row)
    d["nao_lidas"] = int(d.get("nao_lidas") or 0)
    d["tags"] = tags or []
    if d.get("atribuida_usuario_id"):
        d["atribuida_usuario_online"] = whatsapp_service.usuario_esta_online(
            d.pop("_u_ultimo_acesso", None), d.pop("_u_offline_forcado", 0)
        )
    else:
        d.pop("_u_ultimo_acesso", None)
        d.pop("_u_offline_forcado", None)
        d["atribuida_usuario_online"] = None
    return d


def _conversas_com_tags(conn, rows):
    mapa_tags = whatsapp_service.tags_por_conversa(conn, [r["id"] for r in rows])
    return [_conversa_para_json(r, mapa_tags.get(r["id"], [])) for r in rows]


def _carregar_conversa(conn, empresa_id, conversa_id):
    """empresa_id sempre filtra aqui — é o único ponto que TODA rota de
    conversa passa antes de fazer qualquer coisa, então uma conversa de
    outra empresa simplesmente não existe do ponto de vista de quem
    pediu (404, igual não existisse mesmo) — isolamento entre empresas
    depende inteiramente deste filtro."""
    conversa = conn.execute(
        "SELECT c.*, ct.telefone, ct.nome AS contato_nome, ct.foto_url AS contato_foto FROM whatsapp_conversas c "
        "JOIN whatsapp_contatos ct ON ct.id = c.contato_id WHERE c.id = ? AND ct.empresa_id = ?",
        (conversa_id, empresa_id),
    ).fetchone()
    if conversa is None:
        raise ApiError("Conversa não encontrada.", status=404, codigo="nao_encontrado")
    return conversa


def _pode_visualizar(usuario, conversa):
    """Atribuída: só o dono (e o admin). Sem dono (na fila): só quem é do
    MESMO setor pra onde o cliente foi direcionado — mesma régua do botão
    Assumir. Enquanto o setor não está definido (cliente ainda não
    respondeu o menu), só o admin vê: não dá pra saber de quem é."""
    if usuario["admin"]:
        return True
    if conversa["atribuida_usuario_id"] is not None:
        return conversa["atribuida_usuario_id"] == usuario["id"]
    return bool(conversa["menu_setor"]) and conversa["menu_setor"] == usuario["setor"]


# Mesma regra do _pode_visualizar, em SQL, pra filtrar as listas direto no
# banco (o usuário nunca chega a receber a conversa de outro setor).
_SQL_VISIVEL_NAO_ADMIN = (
    "(c.atribuida_usuario_id = ? OR (c.atribuida_usuario_id IS NULL AND c.menu_setor IS NOT NULL AND c.menu_setor = ?))"
)


def _params_visivel(usuario):
    return [usuario["id"], usuario["setor"]]


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
        condicoes, params = ["c.atribuida_usuario_id IS NULL"], []
        if not usuario["admin"]:
            # Usuário comum só enxerga na fila o que é do setor dele.
            condicoes.append("c.menu_setor IS NOT NULL AND c.menu_setor = ?")
            params.append(usuario["setor"])
    elif escopo == "todas":
        if not usuario["admin"]:
            raise ApiError("Só um administrador pode ver todas as conversas.", status=403, codigo="sem_permissao")
        condicoes, params = [], []
    else:
        condicoes, params = ["c.atribuida_usuario_id = ?"], [usuario["id"]]
    condicoes.append("ct.empresa_id = ?")
    params.append(g.empresa_id)

    # Excluídas nunca aparecem em lista nenhuma. Arquivadas só aparecem
    # se pedidas explicitamente (?arquivadas=1) — senão ficam fora do
    # fluxo normal, sem sumir de verdade (dá pra desarquivar depois).
    condicoes.append("c.excluida_em IS NULL")
    condicoes.append("c.arquivada = 1" if incluir_arquivadas else "c.arquivada = 0")

    where = "WHERE " + " AND ".join(condicoes)
    rows = conn.execute(
        f"{base} {where} ORDER BY COALESCE(c.ultima_mensagem_em, c.criado_em) DESC LIMIT 300", params
    ).fetchall()
    return jsonify(_conversas_com_tags(conn, rows))


@bp.get("/conversas/buscar")
@requires_auth
def buscar_conversas():
    usuario = g.usuario_atual
    q = (request.args.get("q") or "").strip()
    if len(q) < 2:
        raise ApiError("Digite ao menos 2 caracteres pra buscar.", status=400)
    conn = get_db()
    termo = f"%{q}%"
    condicoes = [
        "ct.empresa_id = ?",
        "c.excluida_em IS NULL",
        "(ct.nome LIKE ? OR ct.telefone LIKE ? OR EXISTS ("
        "SELECT 1 FROM whatsapp_mensagens m WHERE m.conversa_id = c.id AND m.texto LIKE ? AND m.excluida_em IS NULL))",
    ]
    params = [g.empresa_id, termo, termo, termo]
    if not usuario["admin"]:
        condicoes.append(_SQL_VISIVEL_NAO_ADMIN)
        params.extend(_params_visivel(usuario))
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
        rows = conn.execute(
            "SELECT id, nome, telefone, foto_url FROM whatsapp_contatos WHERE empresa_id = ? AND (nome LIKE ? OR telefone LIKE ?) ORDER BY nome LIMIT 200",
            (g.empresa_id, termo, termo),
        ).fetchall()
    else:
        rows = conn.execute("SELECT id, nome, telefone, foto_url FROM whatsapp_contatos WHERE empresa_id = ? ORDER BY nome LIMIT 500", (g.empresa_id,)).fetchall()
    return jsonify([dict(r) for r in rows])


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
        if not _pode_agir(usuario, conversa):
            raise ApiError(
                f"Já existe uma conversa com este número, atribuída a {conversa['atribuida_usuario_id'] and 'outro usuário' or 'ninguém ainda'}.",
                status=409, codigo="conversa_existente",
            )
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
        "UPDATE whatsapp_conversas SET status = 'aberta', fechada_em = NULL, ultima_mensagem_em = ?, ultima_mensagem_preview = ? WHERE id = ?",
        (agora, texto[:120], conversa["id"]),
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
        raise ApiError("Esta conversa está atribuída a outro usuário.", status=403, codigo="sem_permissao")

    rows = conn.execute(
        "SELECT * FROM whatsapp_mensagens WHERE conversa_id = ? AND excluida_em IS NULL ORDER BY criado_em, id",
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

    conn = get_db()
    conversa = _carregar_conversa(conn, g.empresa_id, conversa_id)
    if not _pode_agir(usuario, conversa):
        raise ApiError("Esta conversa está atribuída a outro usuário — encaminhe para si mesmo antes de responder.", status=403, codigo="sem_permissao")

    whatsapp_service.verificar_repeticao_mensagem(conn, g.empresa_id, texto)

    # Responder uma conversa da fila assume ela automaticamente — evita
    # a etapa extra de "Assumir" antes de simplesmente responder.
    if conversa["atribuida_usuario_id"] is None:
        whatsapp_service.atribuir_conversa(conn, conversa_id, usuario["id"], usuario["id"])

    config = whatsapp_service.obter_configuracao(conn, g.empresa_id)
    agora = _now_iso()
    try:
        externo_id = whatsapp_service.enviar_texto(config, conversa["telefone"], texto)
        status_msg = "enviada"
        erro = None
    except ApiError as e:
        externo_id = None
        status_msg = "falhou"
        erro = e.mensagem

    cur = conn.execute(
        """
        INSERT INTO whatsapp_mensagens (conversa_id, direcao, tipo, texto, externo_id, usuario_id, status, erro, criado_em)
        VALUES (?, 'saida', 'texto', ?, ?, ?, ?, ?, ?)
        """,
        (conversa_id, texto, externo_id, usuario["id"], status_msg, erro, agora),
    )
    conn.execute(
        "UPDATE whatsapp_conversas SET status = 'aberta', fechada_em = NULL, ultima_mensagem_em = ?, ultima_mensagem_preview = ? WHERE id = ?",
        (agora, texto[:120], conversa_id),
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
        raise ApiError("Esta conversa está atribuída a outro usuário.", status=403, codigo="sem_permissao")
    mensagem = conn.execute(
        "SELECT * FROM whatsapp_mensagens WHERE id = ? AND conversa_id = ?", (mensagem_id, conversa_id)
    ).fetchone()
    if mensagem is None:
        raise ApiError("Mensagem não encontrada.", status=404, codigo="nao_encontrado")
    if mensagem["direcao"] != "saida":
        raise ApiError("Só é possível excluir mensagens enviadas por nós.", status=400)
    config = whatsapp_service.obter_configuracao(conn, g.empresa_id)
    apagada_no_whatsapp = whatsapp_service.excluir_mensagem(conn, config, dict(mensagem))
    whatsapp_service.registrar_atividade(conn, usuario["id"], "mensagem_excluida", conversa["telefone"], conversa_id)
    return jsonify({"ok": True, "apagada_no_whatsapp": apagada_no_whatsapp})


@bp.post("/conversas/<int:conversa_id>/mensagens/<int:mensagem_id>/reenviar")
@requires_auth
def reenviar_mensagem(conversa_id, mensagem_id):
    """Reenvia uma mensagem nossa que falhou (ex.: WhatsApp caiu na hora),
    sem precisar escrever ou anexar de novo."""
    usuario = g.usuario_atual
    conn = get_db()
    conversa = _carregar_conversa(conn, g.empresa_id, conversa_id)
    if not _pode_agir(usuario, conversa):
        raise ApiError("Esta conversa está atribuída a outro usuário.", status=403, codigo="sem_permissao")
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
        raise ApiError("Esta conversa já foi assumida por outro usuário.", status=409, codigo="ja_atribuida")
    if not usuario["admin"]:
        if not conversa["menu_setor"]:
            raise ApiError("Essa conversa ainda não tem setor definido — só um administrador pode assumi-la.", status=403, codigo="sem_permissao")
        if conversa["menu_setor"] != usuario["setor"]:
            raise ApiError("Essa conversa é de outro setor — você só pode assumir conversas do seu setor.", status=403, codigo="sem_permissao")
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
        raise ApiError("Esta conversa está atribuída a outro usuário.", status=403, codigo="sem_permissao")
    whatsapp_service.salvar_resumo(conn, conversa_id, (dados.get("resumo") or "").strip() or None)
    return jsonify({"ok": True})


@bp.post("/conversas/<int:conversa_id>/atualizar-foto-contato")
@requires_auth
def atualizar_foto_contato(conversa_id):
    usuario = g.usuario_atual
    conn = get_db()
    conversa = _carregar_conversa(conn, g.empresa_id, conversa_id)
    if not _pode_visualizar(usuario, conversa):
        raise ApiError("Esta conversa está atribuída a outro usuário.", status=403, codigo="sem_permissao")
    config = whatsapp_service.obter_configuracao(conn, g.empresa_id)
    foto_url = whatsapp_service.atualizar_foto_contato(conn, config, conversa["contato_id"], conversa["telefone"])
    return jsonify({"foto_url": foto_url})


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
        raise ApiError("Esta conversa está atribuída a outro usuário.", status=403, codigo="sem_permissao")
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
        raise ApiError("Esta conversa está atribuída a outro usuário.", status=403, codigo="sem_permissao")
    whatsapp_service.criar_nota(conn, conversa_id, usuario["id"], texto)
    return jsonify({"ok": True}), 201


# ============================================================
# ETIQUETAS (TAGS) LIVRES
# ============================================================
@bp.get("/tags")
@requires_auth
def listar_tags():
    conn = get_db()
    return jsonify(whatsapp_service.listar_tags(conn, g.empresa_id))


@bp.post("/tags")
@requires_admin
def criar_tag():
    dados = request.get_json(silent=True) or {}
    nome = (dados.get("nome") or "").strip()
    if not nome:
        raise ApiError("Informe o nome da etiqueta.", status=400)
    conn = get_db()
    return jsonify(whatsapp_service.criar_tag(conn, g.empresa_id, nome, dados.get("cor"))), 201


@bp.delete("/tags/<int:tag_id>")
@requires_admin
def excluir_tag(tag_id):
    conn = get_db()
    if not whatsapp_service.excluir_tag(conn, g.empresa_id, tag_id):
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
        raise ApiError("Esta conversa está atribuída a outro usuário.", status=403, codigo="sem_permissao")
    whatsapp_service.definir_tags_da_conversa(conn, g.empresa_id, conversa_id, dados.get("tag_ids") or [])
    return jsonify({"ok": True})


# ============================================================
# RESPOSTAS PRONTAS
# ============================================================
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
        raise ApiError("Esta conversa está atribuída a outro usuário.", status=403, codigo="sem_permissao")
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
        raise ApiError("Esta conversa está atribuída a outro usuário.", status=403, codigo="sem_permissao")

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


@bp.delete("/agendadas/<int:agendada_id>")
@requires_auth
def cancelar_agendada(agendada_id):
    usuario = g.usuario_atual
    conn = get_db()
    # Confirma que o agendamento é de uma conversa desta empresa antes de
    # mexer — sem isso, dava pra cancelar por ID um agendamento de
    # qualquer outra empresa (ou de qualquer outro usuário).
    valido = conn.execute(
        """
        SELECT 1 FROM whatsapp_mensagens_agendadas a
        JOIN whatsapp_conversas c ON c.id = a.conversa_id
        JOIN whatsapp_contatos ct ON ct.id = c.contato_id
        WHERE a.id = ? AND ct.empresa_id = ?
        """,
        (agendada_id, g.empresa_id),
    ).fetchone()
    if valido is None:
        raise ApiError("Agendamento não encontrado.", status=404, codigo="nao_encontrado")
    whatsapp_service.cancelar_agendada(conn, agendada_id)
    whatsapp_service.registrar_atividade(conn, usuario["id"], "agendamento_cancelado")
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
        raise ApiError("Esta conversa está atribuída a outro usuário.", status=403, codigo="sem_permissao")
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


@bp.post("/lembretes/<int:lembrete_id>/concluir")
@requires_auth
def concluir_lembrete(lembrete_id):
    usuario = g.usuario_atual
    conn = get_db()
    valido = conn.execute(
        """
        SELECT 1 FROM whatsapp_lembretes l
        JOIN whatsapp_conversas c ON c.id = l.conversa_id
        JOIN whatsapp_contatos ct ON ct.id = c.contato_id
        WHERE l.id = ? AND ct.empresa_id = ?
        """,
        (lembrete_id, g.empresa_id),
    ).fetchone()
    if valido is None:
        raise ApiError("Lembrete não encontrado.", status=404, codigo="nao_encontrado")
    whatsapp_service.concluir_lembrete(conn, lembrete_id)
    whatsapp_service.registrar_atividade(conn, usuario["id"], "lembrete_concluido")
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
        raise ApiError("Esta conversa está atribuída a outro usuário — encaminhe para si mesmo antes de responder.", status=403, codigo="sem_permissao")

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
        "UPDATE whatsapp_conversas SET status = 'aberta', fechada_em = NULL, ultima_mensagem_em = ?, ultima_mensagem_preview = ? WHERE id = ?",
        (agora, f"📎 {legenda or arquivo.filename}"[:120], conversa_id),
    )
    mensagem = dict(conn.execute("SELECT * FROM whatsapp_mensagens WHERE id = ?", (cur.lastrowid,)).fetchone())
    whatsapp_service.registrar_atividade(conn, usuario["id"], "anexo_enviado", arquivo.filename, conversa_id)
    if status_msg == "falhou":
        raise ApiError(f"Anexo registrado, mas o envio falhou: {erro}", status=502)
    return jsonify(mensagem), 201


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
    que a pessoa já tinha permissão de ver."""
    return send_from_directory(PASTA_UPLOADS, nome_arquivo)


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
