"""
Chat interno privado entre colaboradores — nada disso passa pelo
WhatsApp/Evolution API, é 100% interno ao sistema. Mesma régua de
visibilidade das conversas de clientes: só os dois participantes (mais
admin, em modo supervisão) veem/agem numa conversa.
"""
import os
import secrets

from flask import Blueprint, g, jsonify, request
from werkzeug.utils import secure_filename

from .. import chat_interno_service, transcricao, whatsapp_service
from ..context import ApiError, get_db, requires_auth
# Reaproveita os limites, a classificação de tipo e a pasta de anexos do
# WhatsApp — anexo é anexo, não faz sentido ter duas regras diferentes.
from . import whatsapp as rotas_whatsapp

bp = Blueprint("chat_interno", __name__, url_prefix="/api/v1/chat-interno")


def _pode_ver(usuario, conversa):
    # Admin só vê se for admin DA MESMA EMPRESA — sem isso um admin de
    # outra empresa (mesmo banco compartilhado) conseguiria espiar
    # conversas internas privadas de outra empresa só por ser admin.
    if conversa["empresa_id"] != usuario["empresa_id"]:
        return False
    return usuario["admin"] or usuario["id"] in (conversa["criado_por_id"], conversa["participante_id"])


def _carregar(conn, empresa_id, conversa_id):
    conversa = chat_interno_service.carregar_conversa(conn, conversa_id)
    if conversa is None or conversa["empresa_id"] != empresa_id:
        raise ApiError("Conversa não encontrada.", status=404, codigo="nao_encontrado")
    return conversa


@bp.get("/conversas")
@requires_auth
def listar_conversas():
    usuario = g.usuario_atual
    incluir_encerradas = request.args.get("encerradas") == "1"
    todas = request.args.get("todas") == "1"
    if todas and not usuario["admin"]:
        raise ApiError("Só um administrador pode ver todas as conversas internas.", status=403, codigo="sem_permissao")
    conn = get_db()
    return jsonify(chat_interno_service.listar_conversas(
        conn, usuario["id"], incluir_encerradas,
        empresa_id_admin=usuario["empresa_id"] if todas else None,
        tag_id=request.args.get("tag_id"),
    ))


@bp.post("/conversas")
@requires_auth
def iniciar_conversa():
    """Cada dupla de pessoas tem no máximo UMA conversa interna — se já
    existir uma (mesmo encerrada), reaproveita e reabre em vez de criar
    outra do zero."""
    usuario = g.usuario_atual
    dados = request.get_json(silent=True) or {}
    participante_id = dados.get("participante_id")
    texto = (dados.get("texto") or "").strip() or None
    if not participante_id:
        raise ApiError("Escolha com quem você quer falar.", status=400)
    if int(participante_id) == usuario["id"]:
        raise ApiError("Você não pode iniciar uma conversa interna consigo mesmo.", status=400)
    conn = get_db()
    participante = conn.execute(
        "SELECT id, setor FROM usuarios WHERE id = ? AND ativo = 1 AND empresa_id = ?", (participante_id, usuario["empresa_id"])
    ).fetchone()
    if participante is None:
        raise ApiError("Colaborador não encontrado ou inativo.", status=400)

    conversa_id = chat_interno_service.buscar_conversa_existente(conn, usuario["id"], participante["id"])
    if conversa_id:
        chat_interno_service.reabrir_conversa(conn, conversa_id)
        if texto:
            chat_interno_service.enviar_mensagem(conn, conversa_id, usuario["id"], texto)
    else:
        conversa_id = chat_interno_service.iniciar_conversa(conn, usuario["id"], participante["id"], participante["setor"], texto)
    return jsonify(chat_interno_service.carregar_conversa(conn, conversa_id)), 201


@bp.get("/conversas/<int:conversa_id>/mensagens")
@requires_auth
def listar_mensagens(conversa_id):
    usuario = g.usuario_atual
    conn = get_db()
    conversa = _carregar(conn, usuario["empresa_id"], conversa_id)
    if not _pode_ver(usuario, conversa):
        raise ApiError("Esta conversa é privada entre outras duas pessoas.", status=403, codigo="sem_permissao")
    if conversa["criado_por_id"] == usuario["id"]:
        lado = "criador"
    elif conversa["participante_id"] == usuario["id"]:
        lado = "participante"
    else:
        lado = None  # admin espiando pela aba "Todas" — não conta como leitura
    # Mensagem apagada só aparece pro admin em SUPERVISÃO — quando ele
    # está olhando uma conversa que não é dele (lado is None).
    #
    # Antes bastava ser admin, e a mensagem apagada aparecia até na
    # conversa em que ele mesmo participa: quem apagou some do próprio
    # lado, mas o texto continuava riscado na tela do outro, no meio de
    # uma conversa normal. Supervisão é onde essa informação serve; numa
    # conversa que é dele, só atrapalha.
    supervisionando = usuario["admin"] and lado is None
    mensagens = chat_interno_service.listar_mensagens(conn, conversa_id, lado, incluir_excluidas=supervisionando)
    return jsonify(mensagens)


@bp.post("/conversas/<int:conversa_id>/mensagens/<int:mensagem_id>/transcrever")
@requires_auth
def transcrever_audio_interno(conversa_id, mensagem_id):
    """Mesma coisa das conversas de cliente, com a régua de visibilidade
    do chat interno: só quem participa (ou o admin) pode pedir."""
    usuario = g.usuario_atual
    conn = get_db()
    conversa = _carregar(conn, usuario["empresa_id"], conversa_id)
    if not _pode_ver(usuario, conversa):
        raise ApiError("Esta conversa é privada entre outras duas pessoas.", status=403, codigo="sem_permissao")
    mensagem = conn.execute(
        "SELECT * FROM chat_interno_mensagens WHERE id = ? AND conversa_id = ?", (mensagem_id, conversa_id)
    ).fetchone()
    if mensagem is None:
        raise ApiError("Mensagem não encontrada.", status=404, codigo="nao_encontrado")
    if mensagem["transcricao_em"]:
        return jsonify({"transcricao": mensagem["transcricao"] or "", "de_cache": True})
    if mensagem["tipo"] != "audio":
        raise ApiError("Essa mensagem não é um áudio.", status=400)

    caminho = rotas_whatsapp._caminho_do_anexo(mensagem["midia_url"])
    if caminho is None:
        raise ApiError("O arquivo deste áudio não está mais no servidor.", status=404, codigo="nao_encontrado")
    try:
        texto = transcricao.transcrever(caminho)
    except transcricao.TranscricaoIndisponivel as e:
        raise ApiError(str(e), status=503)
    except Exception:
        raise ApiError("Não consegui transcrever este áudio. Tente de novo em instantes.", status=500)

    conn.execute(
        "UPDATE chat_interno_mensagens SET transcricao = ?, transcricao_em = ? WHERE id = ?",
        (texto, whatsapp_service._now_iso(), mensagem_id),
    )
    return jsonify({"transcricao": texto, "de_cache": False})


@bp.put("/conversas/<int:conversa_id>/tags")
@requires_auth
def definir_tags(conversa_id):
    """Etiqueta uma conversa interna. Mesma régua de visibilidade do
    resto: só quem participa (ou o admin, supervisionando) pode mexer."""
    usuario = g.usuario_atual
    conn = get_db()
    conversa = _carregar(conn, usuario["empresa_id"], conversa_id)
    if not _pode_ver(usuario, conversa):
        raise ApiError("Esta conversa é privada entre outras duas pessoas.", status=403, codigo="sem_permissao")
    dados = request.get_json(silent=True) or {}
    chat_interno_service.definir_tags_da_conversa(conn, usuario["empresa_id"], usuario["id"], conversa_id, dados.get("tag_ids") or [])
    return jsonify({"ok": True})


@bp.put("/conversas/<int:conversa_id>/apelido")
@requires_auth
def definir_apelido(conversa_id):
    """Apelido é sempre "de quem estou falando NESSA conversa" — só faz
    sentido pra quem é de fato um dos dois lados (não pro admin espiando
    pela aba "Todas", que não tem relação pessoal com essa conversa)."""
    usuario = g.usuario_atual
    conn = get_db()
    conversa = _carregar(conn, usuario["empresa_id"], conversa_id)
    if conversa["criado_por_id"] == usuario["id"]:
        alvo_id = conversa["participante_id"]
    elif conversa["participante_id"] == usuario["id"]:
        alvo_id = conversa["criado_por_id"]
    else:
        raise ApiError("Você não participa dessa conversa.", status=403, codigo="sem_permissao")
    if alvo_id is None:
        raise ApiError("Essa conversa ainda não tem participante definido.", status=400)
    dados = request.get_json(silent=True) or {}
    chat_interno_service.definir_apelido(conn, usuario["id"], alvo_id, dados.get("apelido"))
    return jsonify({"ok": True})


@bp.post("/conversas/<int:conversa_id>/mensagens")
@requires_auth
def enviar_mensagem(conversa_id):
    usuario = g.usuario_atual
    dados = request.get_json(silent=True) or {}
    texto = (dados.get("texto") or "").strip()
    if not texto:
        raise ApiError("Digite uma mensagem.", status=400)
    conn = get_db()
    conversa = _carregar(conn, usuario["empresa_id"], conversa_id)
    if usuario["id"] not in (conversa["criado_por_id"], conversa["participante_id"]):
        raise ApiError("Esta conversa é privada entre outras duas pessoas.", status=403, codigo="sem_permissao")
    # A mensagem citada tem que ser desta conversa — senão daria pra
    # citar por id um trecho de uma conversa privada de outras pessoas.
    responde_a = dados.get("responde_a")
    if responde_a:
        existe = conn.execute(
            "SELECT 1 FROM chat_interno_mensagens WHERE id = ? AND conversa_id = ?", (responde_a, conversa_id)
        ).fetchone()
        if existe is None:
            raise ApiError("A mensagem citada não é desta conversa.", status=400)
        responde_a = int(responde_a)
    else:
        responde_a = None
    chat_interno_service.enviar_mensagem(conn, conversa_id, usuario["id"], texto, responde_a=responde_a)
    return jsonify({"ok": True}), 201


@bp.put("/conversas/<int:conversa_id>/mensagens/<int:mensagem_id>")
@requires_auth
def editar_mensagem(conversa_id, mensagem_id):
    """Corrige o que você escreveu. Só o autor edita — nem o admin
    reescreve a fala de outra pessoa — e a bolha passa a mostrar
    "editada", pra ninguém mudar o que disse sem deixar rastro."""
    usuario = g.usuario_atual
    conn = get_db()
    conversa = _carregar(conn, usuario["empresa_id"], conversa_id)
    mensagem = conn.execute(
        "SELECT * FROM chat_interno_mensagens WHERE id = ? AND conversa_id = ?", (mensagem_id, conversa_id)
    ).fetchone()
    if mensagem is None:
        raise ApiError("Mensagem não encontrada.", status=404, codigo="nao_encontrado")
    if mensagem["usuario_id"] != usuario["id"]:
        raise ApiError("Só quem escreveu pode editar a própria mensagem.", status=403, codigo="sem_permissao")
    if mensagem["excluida_em"]:
        raise ApiError("Essa mensagem foi apagada.", status=400)
    texto = ((request.get_json(silent=True) or {}).get("texto") or "").strip()
    if not texto:
        raise ApiError("Escreva o novo texto.", status=400)
    chat_interno_service.editar_mensagem(conn, mensagem_id, texto)
    return jsonify({"ok": True})


@bp.post("/conversas/<int:conversa_id>/lembretes")
@requires_auth
def criar_lembrete(conversa_id):
    """Lembrete pessoal atrelado a uma conversa interna — avisa só quem
    pediu, na hora marcada. Mesma tabela dos lembretes de cliente, então
    aparece junto na tela de Lembretes."""
    usuario = g.usuario_atual
    conn = get_db()
    conversa = _carregar(conn, usuario["empresa_id"], conversa_id)
    if not _pode_ver(usuario, conversa):
        raise ApiError("Esta conversa é privada entre outras duas pessoas.", status=403, codigo="sem_permissao")
    dados = request.get_json(silent=True) or {}
    lembrar_em = (dados.get("lembrar_em") or "").strip()
    if not lembrar_em:
        raise ApiError("Informe quando quer ser lembrado.", status=400)
    conn.execute(
        """INSERT INTO whatsapp_lembretes (chat_interno_conversa_id, usuario_id, texto, lembrar_em, criado_por, criado_em)
           VALUES (?, ?, ?, ?, ?, ?)""",
        (conversa_id, usuario["id"], (dados.get("texto") or "").strip() or None,
         lembrar_em, usuario["id"], whatsapp_service._now_iso()),
    )
    return jsonify({"ok": True}), 201


@bp.post("/conversas/<int:conversa_id>/agendar")
@requires_auth
def agendar_mensagem(conversa_id):
    """Escreve agora, o colega recebe na hora marcada. Não depende do
    WhatsApp estar conectado — a entrega é interna (ver
    whatsapp_service.processar_agendadas_vencidas)."""
    usuario = g.usuario_atual
    conn = get_db()
    conversa = _carregar(conn, usuario["empresa_id"], conversa_id)
    if usuario["id"] not in (conversa["criado_por_id"], conversa["participante_id"]):
        raise ApiError("Esta conversa é privada entre outras duas pessoas.", status=403, codigo="sem_permissao")
    dados = request.get_json(silent=True) or {}
    texto = (dados.get("texto") or "").strip()
    agendado_para = (dados.get("agendado_para") or "").strip()
    if not texto:
        raise ApiError("Escreva a mensagem que será enviada.", status=400)
    if not agendado_para:
        raise ApiError("Informe quando enviar.", status=400)
    cur = conn.execute(
        """INSERT INTO whatsapp_mensagens_agendadas (chat_interno_conversa_id, texto, agendado_para, criado_por, criado_em)
           VALUES (?, ?, ?, ?, ?)""",
        (conversa_id, texto, agendado_para, usuario["id"], whatsapp_service._now_iso()),
    )
    return jsonify({"ok": True, "id": cur.lastrowid}), 201


@bp.delete("/conversas/<int:conversa_id>/mensagens/<int:mensagem_id>")
@requires_auth
def excluir_mensagem(conversa_id, mensagem_id):
    """Apaga uma mensagem mandada por engano (texto, foto, áudio, o que
    for). Só a PRÓPRIA mensagem: não dá pra apagar o que o colega
    escreveu — nem admin, que aqui é só supervisor."""
    usuario = g.usuario_atual
    conn = get_db()
    conversa = _carregar(conn, usuario["empresa_id"], conversa_id)
    if usuario["id"] not in (conversa["criado_por_id"], conversa["participante_id"]):
        raise ApiError("Esta conversa é privada entre outras duas pessoas.", status=403, codigo="sem_permissao")
    mensagem = conn.execute(
        "SELECT usuario_id FROM chat_interno_mensagens WHERE id = ? AND conversa_id = ?", (mensagem_id, conversa_id)
    ).fetchone()
    if mensagem is None:
        raise ApiError("Mensagem não encontrada.", status=404, codigo="nao_encontrado")
    if mensagem["usuario_id"] != usuario["id"]:
        raise ApiError("Só dá pra apagar as suas próprias mensagens.", status=403, codigo="sem_permissao")
    conn.execute(
        "UPDATE chat_interno_mensagens SET excluida_em = ?, excluida_por = ? WHERE id = ?",
        (whatsapp_service._now_iso(), usuario["id"], mensagem_id),
    )
    # Fica no registro de atividades pro administrador saber que algo foi
    # apagado — a mensagem some da tela de quem apagou, mas não do
    # histórico da empresa.
    whatsapp_service.registrar_atividade(conn, usuario["id"], "mensagem_interna_excluida", f"conversa interna #{conversa_id}")
    return jsonify({"ok": True})


@bp.post("/conversas/<int:conversa_id>/anexo")
@requires_auth
def enviar_anexo(conversa_id):
    """Imagem, vídeo, documento ou áudio gravado no chat interno.

    Guarda o arquivo na MESMA pasta dos anexos de WhatsApp e serve pela
    mesma rota (/whatsapp/uploads/<arquivo>), com nome aleatório de 16
    hex — é o que já funciona com <img src> e link de download, sem
    duplicar a lógica de servir arquivo em dois lugares."""
    usuario = g.usuario_atual
    conn = get_db()
    conversa = _carregar(conn, usuario["empresa_id"], conversa_id)
    if usuario["id"] not in (conversa["criado_por_id"], conversa["participante_id"]):
        raise ApiError("Esta conversa é privada entre outras duas pessoas.", status=403, codigo="sem_permissao")

    arquivo = request.files.get("arquivo")
    if not arquivo or not arquivo.filename:
        raise ApiError("Nenhum arquivo enviado.", status=400)
    dados_bytes = arquivo.read()
    if len(dados_bytes) > rotas_whatsapp.MAX_ANEXO_MB * 1024 * 1024:
        raise ApiError(f"Arquivo maior que o limite de {rotas_whatsapp.MAX_ANEXO_MB}MB.", status=400)

    # A gravação de áudio manda tipo="audio" explícito: o nome do arquivo
    # sozinho (audio.webm) não distingue de um vídeo .webm anexado.
    tipo_forcado = request.form.get("tipo")
    tipo = tipo_forcado if tipo_forcado in rotas_whatsapp.EXTENSOES_TIPO else rotas_whatsapp._classificar_tipo(arquivo.filename)
    legenda = (request.form.get("legenda") or "").strip() or None

    os.makedirs(rotas_whatsapp.PASTA_UPLOADS, exist_ok=True)
    nome_seguro = f"{secrets.token_hex(8)}_{secure_filename(arquivo.filename)}"
    with open(os.path.join(rotas_whatsapp.PASTA_UPLOADS, nome_seguro), "wb") as f:
        f.write(dados_bytes)
    midia_url = f"/api/v1/whatsapp/uploads/{nome_seguro}"

    chat_interno_service.enviar_mensagem(
        conn, conversa_id, usuario["id"], legenda, tipo=tipo, midia_url=midia_url, nome_arquivo=arquivo.filename
    )
    return jsonify({"ok": True, "midia_url": midia_url, "tipo": tipo}), 201


@bp.post("/conversas/<int:conversa_id>/digitando")
@requires_auth
def marcar_digitando(conversa_id):
    usuario = g.usuario_atual
    conn = get_db()
    conversa = _carregar(conn, usuario["empresa_id"], conversa_id)
    if usuario["id"] == conversa["criado_por_id"]:
        lado = "criador"
    elif usuario["id"] == conversa["participante_id"]:
        lado = "participante"
    else:
        return jsonify({"ok": True})  # admin espiando não "digita" pra ninguém
    chat_interno_service.marcar_digitando(conn, conversa_id, lado)
    return jsonify({"ok": True})


@bp.post("/conversas/<int:conversa_id>/encaminhar")
@requires_auth
def encaminhar(conversa_id):
    usuario = g.usuario_atual
    dados = request.get_json(silent=True) or {}
    novo_participante_id = dados.get("participante_id")
    if not novo_participante_id:
        raise ApiError("Escolha pra quem encaminhar.", status=400)
    conn = get_db()
    conversa = _carregar(conn, usuario["empresa_id"], conversa_id)
    if usuario["id"] not in (conversa["criado_por_id"], conversa["participante_id"]) and not usuario["admin"]:
        raise ApiError("Esta conversa é privada entre outras duas pessoas.", status=403, codigo="sem_permissao")
    if int(novo_participante_id) == conversa["criado_por_id"]:
        raise ApiError("Não é possível encaminhar para quem iniciou a conversa.", status=400)
    novo = conn.execute(
        "SELECT id, nome, setor FROM usuarios WHERE id = ? AND ativo = 1 AND empresa_id = ?", (novo_participante_id, usuario["empresa_id"])
    ).fetchone()
    if novo is None:
        raise ApiError("Colaborador não encontrado ou inativo.", status=400)
    chat_interno_service.encaminhar_conversa(conn, conversa_id, novo["id"], novo["setor"], usuario["id"])
    whatsapp_service.registrar_atividade(conn, usuario["id"], "chat_interno_encaminhado", f"-> {novo['nome']}")
    return jsonify({"ok": True})


@bp.post("/conversas/<int:conversa_id>/fechar")
@requires_auth
def fechar(conversa_id):
    usuario = g.usuario_atual
    conn = get_db()
    conversa = _carregar(conn, usuario["empresa_id"], conversa_id)
    if not _pode_ver(usuario, conversa):
        raise ApiError("Esta conversa é privada entre outras duas pessoas.", status=403, codigo="sem_permissao")
    chat_interno_service.fechar_conversa(conn, conversa_id)
    return jsonify({"ok": True})


@bp.post("/conversas/<int:conversa_id>/reabrir")
@requires_auth
def reabrir(conversa_id):
    usuario = g.usuario_atual
    conn = get_db()
    conversa = _carregar(conn, usuario["empresa_id"], conversa_id)
    if not _pode_ver(usuario, conversa):
        raise ApiError("Esta conversa é privada entre outras duas pessoas.", status=403, codigo="sem_permissao")
    chat_interno_service.reabrir_conversa(conn, conversa_id)
    return jsonify({"ok": True})
