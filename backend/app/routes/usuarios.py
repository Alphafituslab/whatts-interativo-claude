import datetime
import json
import os
import secrets

from flask import Blueprint, g, jsonify, request, send_from_directory
from werkzeug.utils import secure_filename

from .. import security, whatsapp_service
from ..context import ApiError, get_db, requires_admin, requires_auth

bp = Blueprint("usuarios", __name__, url_prefix="/api/v1/usuarios")

PASTA_FOTOS = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "data", "fotos_perfil")
EXTENSOES_FOTO_PERMITIDAS = {"jpg", "jpeg", "png", "gif", "webp"}
MAX_FOTO_MB = 5


def _now_iso():
    return datetime.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def _online(u):
    ultimo = u["ultimo_acesso"] if "ultimo_acesso" in u.keys() else None
    forcado = u["offline_forcado"] if "offline_forcado" in u.keys() else 0
    ausente = u["ausente"] if "ausente" in u.keys() else 0
    return whatsapp_service.usuario_esta_online(ultimo, forcado, ausente)


def _publico(u, setores=None):
    horario = u["horario_permitido"] if "horario_permitido" in u.keys() else None
    if setores is not None:
        u = dict(u)
        u["_setores"] = setores
    return {
        "id": u["id"], "nome": u["nome"], "email": u["email"], "admin": bool(u["admin"]), "ativo": bool(u["ativo"]),
        "foto_perfil": u["foto_perfil"] if "foto_perfil" in u.keys() else None,
        "horario_permitido": json.loads(horario) if horario else [],
        "setor": u["setor"] if "setor" in u.keys() else None,
        # setores: todos os que a pessoa atende. "setor" (singular) é o
        # principal, mantido pra onde só cabe um rótulo.
        "setores": u["_setores"] if "_setores" in u.keys() else None,
        "offline_forcado": bool(u["offline_forcado"]) if "offline_forcado" in u.keys() else False,
        "acesso_conversas": bool(u["acesso_conversas"]) if "acesso_conversas" in u.keys() else True,
        "online": _online(u),
        "ausente": bool(u["ausente"]) if "ausente" in u.keys() else False,
        "ausente_motivo": u["ausente_motivo"] if "ausente_motivo" in u.keys() else None,
    }


def _setores_do_pedido(conn, dados, admin):
    """Aceita a lista nova (setores) e continua aceitando o campo antigo
    (setor), pra não quebrar nada que ainda mande um só.

    Admin não precisa de setor: ele vê a empresa toda, não uma fila."""
    brutos = dados.get("setores")
    if brutos is None:
        um = (dados.get("setor") or "").strip()
        brutos = [um] if um else []
    if not isinstance(brutos, list):
        raise ApiError("Formato de setores inválido.", status=400)
    escolhidos = [(x or "").strip() for x in brutos if (x or "").strip()]
    if admin:
        return escolhidos  # pode ficar vazio
    if not escolhidos:
        raise ApiError("Escolha pelo menos um setor — é por ele que as conversas chegam nesta pessoa.", status=400)
    validos = whatsapp_service.obter_setores(conn, g.empresa_id)
    for nome in escolhidos:
        if nome not in validos:
            raise ApiError(f"O setor '{nome}' não existe.", status=400)
    return escolhidos


def _validar_horario_permitido(janelas):
    if not isinstance(janelas, list):
        raise ApiError("Formato de horário inválido.", status=400)
    for j in janelas:
        inicio, fim = (j or {}).get("inicio"), (j or {}).get("fim")
        if not inicio or not fim or inicio >= fim:
            raise ApiError("Cada janela de horário precisa de início antes do fim (ex.: 08:00–12:00).", status=400)
    return json.dumps(janelas) if janelas else None


@bp.get("/setores")
@requires_auth
def listar_setores():
    conn = get_db()
    return jsonify(whatsapp_service.obter_setores(conn, g.empresa_id))


@bp.get("/setores/detalhado")
@requires_admin
def listar_setores_detalhado():
    """Versão com id, pra tela de Configuração poder renomear/excluir
    (a rota simples acima devolve só os nomes, usada pra popular os
    dropdowns de seleção em todo o resto do sistema)."""
    conn = get_db()
    rows = conn.execute(
        "SELECT id, nome FROM whatsapp_setores WHERE empresa_id = ? ORDER BY ordem, id", (g.empresa_id,)
    ).fetchall()
    return jsonify([{"id": r["id"], "nome": r["nome"]} for r in rows])


@bp.post("/setores")
@requires_admin
def criar_setor():
    dados = request.get_json(silent=True) or {}
    conn = get_db()
    setores = whatsapp_service.criar_setor(conn, g.empresa_id, dados.get("nome"))
    return jsonify(setores), 201


@bp.put("/setores/<int:setor_id>")
@requires_admin
def renomear_setor(setor_id):
    dados = request.get_json(silent=True) or {}
    conn = get_db()
    setores = whatsapp_service.renomear_setor(conn, g.empresa_id, setor_id, dados.get("nome"))
    return jsonify(setores)


@bp.delete("/setores/<int:setor_id>")
@requires_admin
def excluir_setor(setor_id):
    conn = get_db()
    if not whatsapp_service.excluir_setor(conn, g.empresa_id, setor_id):
        raise ApiError("Setor não encontrado.", status=404, codigo="nao_encontrado")
    return jsonify({"ok": True})


@bp.get("")
@requires_auth
def listar():
    conn = get_db()
    rows = conn.execute("SELECT * FROM usuarios WHERE empresa_id = ? ORDER BY nome", (g.empresa_id,)).fetchall()
    mapa = whatsapp_service.setores_por_usuario(conn, [r["id"] for r in rows])
    return jsonify([_publico(r, mapa.get(r["id"], [])) for r in rows])


@bp.post("")
@requires_admin
def criar():
    dados = request.get_json(silent=True) or {}
    nome = (dados.get("nome") or "").strip()
    email = (dados.get("email") or "").strip().lower()
    senha = dados.get("senha") or ""
    admin = 1 if dados.get("admin") else 0

    if not nome or not email or not senha:
        raise ApiError("Informe nome, email e senha.", status=400)
    conn = get_db()
    setores = _setores_do_pedido(conn, dados, admin)
    problemas = security.validar_politica_senha(senha)
    if problemas:
        raise ApiError(" ".join(problemas), status=400)
    horario_permitido = _validar_horario_permitido(dados.get("horario_permitido") or [])

    ja_existe = conn.execute("SELECT 1 FROM usuarios WHERE email = ?", (email,)).fetchone()
    if ja_existe:
        raise ApiError("Já existe um usuário com este email.", status=409, codigo="email_duplicado")

    cur = conn.execute(
        "INSERT INTO usuarios (nome, email, senha_hash, admin, ativo, horario_permitido, setor, criado_em, empresa_id, acesso_conversas) "
        "VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?)",
        (nome, email, security.hash_password(senha), admin, horario_permitido, setores[0] if setores else None,
         _now_iso(), g.empresa_id, 1 if (admin or dados.get("acesso_conversas", True)) else 0),
    )
    whatsapp_service.definir_setores_do_usuario(conn, cur.lastrowid, setores)
    usuario = conn.execute("SELECT * FROM usuarios WHERE id = ?", (cur.lastrowid,)).fetchone()
    return jsonify(_publico(usuario, setores)), 201


@bp.put("/<int:usuario_id>")
@requires_admin
def editar(usuario_id):
    usuario_atual = g.usuario_atual
    dados = request.get_json(silent=True) or {}
    nome = (dados.get("nome") or "").strip()
    email = (dados.get("email") or "").strip().lower()
    admin = 1 if dados.get("admin") else 0
    offline_forcado = 1 if dados.get("offline_forcado") else 0

    if not nome or not email:
        raise ApiError("Informe nome e email.", status=400)
    conn = get_db()
    setores = _setores_do_pedido(conn, dados, admin)
    if usuario_id == usuario_atual["id"] and not admin:
        raise ApiError("Você não pode remover seu próprio acesso de administrador.", status=400)

    alvo = conn.execute("SELECT 1 FROM usuarios WHERE id = ? AND empresa_id = ?", (usuario_id, g.empresa_id)).fetchone()
    if alvo is None:
        raise ApiError("Usuário não encontrado.", status=404, codigo="nao_encontrado")
    duplicado = conn.execute("SELECT 1 FROM usuarios WHERE email = ? AND id != ?", (email, usuario_id)).fetchone()
    if duplicado:
        raise ApiError("Já existe um usuário com este email.", status=409, codigo="email_duplicado")

    # Admin sempre enxerga as conversas — guardar 0 aqui pra um admin só
    # criaria um estado contraditório (menu escondido, API liberada).
    acesso_conversas = 1 if (admin or dados.get("acesso_conversas")) else 0
    conn.execute(
        "UPDATE usuarios SET nome = ?, email = ?, admin = ?, offline_forcado = ?, acesso_conversas = ? WHERE id = ?",
        (nome, email, admin, offline_forcado, acesso_conversas, usuario_id),
    )
    # Regrava a lista e acerta o setor principal (usuarios.setor) junto.
    whatsapp_service.definir_setores_do_usuario(conn, usuario_id, setores)
    usuario = conn.execute("SELECT * FROM usuarios WHERE id = ?", (usuario_id,)).fetchone()
    return jsonify(_publico(usuario, setores))


@bp.put("/<int:usuario_id>/senha")
@requires_admin
def redefinir_senha(usuario_id):
    """Admin redefine a senha de qualquer usuário (ex.: esqueceu a senha)
    — sem precisar da senha atual, diferente da troca self-service em
    Segurança. Revoga todas as sessões ativas dele por segurança: com a
    senha trocada por outra pessoa, ele precisa logar de novo mesmo."""
    dados = request.get_json(silent=True) or {}
    senha_nova = dados.get("senha_nova") or ""
    conn = get_db()
    alvo = conn.execute("SELECT email FROM usuarios WHERE id = ? AND empresa_id = ?", (usuario_id, g.empresa_id)).fetchone()
    if alvo is None:
        raise ApiError("Usuário não encontrado.", status=404, codigo="nao_encontrado")
    problemas = security.validar_politica_senha(senha_nova)
    if problemas:
        raise ApiError(" ".join(problemas), status=400)
    conn.execute("UPDATE usuarios SET senha_hash = ? WHERE id = ?", (security.hash_password(senha_nova), usuario_id))
    conn.execute("UPDATE sessoes SET revogado = 1 WHERE usuario_id = ?", (usuario_id,))
    whatsapp_service.registrar_atividade(conn, g.usuario_atual["id"], "senha_redefinida_admin", alvo["email"])
    return jsonify({"ok": True})


@bp.post("/<int:usuario_id>/inativar")
@requires_admin
def inativar(usuario_id):
    usuario_atual = g.usuario_atual
    if usuario_id == usuario_atual["id"]:
        raise ApiError("Você não pode inativar a si mesmo.", status=400)
    conn = get_db()
    cur = conn.execute("UPDATE usuarios SET ativo = 0 WHERE id = ? AND empresa_id = ?", (usuario_id, g.empresa_id))
    if cur.rowcount == 0:
        raise ApiError("Usuário não encontrado.", status=404, codigo="nao_encontrado")
    return jsonify({"ok": True})


@bp.post("/<int:usuario_id>/reativar")
@requires_admin
def reativar(usuario_id):
    conn = get_db()
    cur = conn.execute("UPDATE usuarios SET ativo = 1 WHERE id = ? AND empresa_id = ?", (usuario_id, g.empresa_id))
    if cur.rowcount == 0:
        raise ApiError("Usuário não encontrado.", status=404, codigo="nao_encontrado")
    return jsonify({"ok": True})


@bp.put("/<int:usuario_id>/horario")
@requires_admin
def definir_horario(usuario_id):
    dados = request.get_json(silent=True) or {}
    horario_permitido = _validar_horario_permitido(dados.get("horario_permitido") or [])
    conn = get_db()
    alvo = conn.execute("SELECT 1 FROM usuarios WHERE id = ? AND empresa_id = ?", (usuario_id, g.empresa_id)).fetchone()
    if alvo is None:
        raise ApiError("Usuário não encontrado.", status=404, codigo="nao_encontrado")
    conn.execute("UPDATE usuarios SET horario_permitido = ? WHERE id = ?", (horario_permitido, usuario_id))
    return jsonify({"ok": True})


@bp.put("/ausente")
@requires_auth
def definir_ausente():
    """A própria pessoa avisa que saiu ("almoço", "reunião").

    Diferente de offline_forcado, que é do admin pra quem está de férias
    ou afastado: aqui é autosserviço, do mesmo jeito que trocar a
    própria foto ou senha. Quem está ausente sai das listas de quem
    pode atender, e o menu automático deixa de oferecer o setor se todo
    mundo dele estiver assim."""
    usuario = g.usuario_atual
    dados = request.get_json(silent=True) or {}
    ausente = 1 if dados.get("ausente") else 0
    motivo = (dados.get("motivo") or "").strip()[:60] or None
    conn = get_db()
    conn.execute(
        "UPDATE usuarios SET ausente = ?, ausente_motivo = ?, ausente_ate = ? WHERE id = ?",
        (ausente, motivo if ausente else None,
         (dados.get("ate") or None) if ausente else None, usuario["id"]),
    )
    linha = conn.execute("SELECT * FROM usuarios WHERE id = ?", (usuario["id"],)).fetchone()
    return jsonify(_publico(linha, whatsapp_service.setores_do_usuario(conn, usuario["id"])))


@bp.put("/perfil")
@requires_auth
def editar_perfil():
    """Cada usuário troca o próprio nome de exibição — mesma lógica de
    autosserviço da foto de perfil e da senha, sem precisar de admin."""
    usuario = g.usuario_atual
    dados = request.get_json(silent=True) or {}
    nome = (dados.get("nome") or "").strip()
    if not nome:
        raise ApiError("Informe um nome.", status=400)
    conn = get_db()
    conn.execute("UPDATE usuarios SET nome = ? WHERE id = ?", (nome, usuario["id"]))
    usuario_atualizado = conn.execute("SELECT * FROM usuarios WHERE id = ?", (usuario["id"],)).fetchone()
    return jsonify(_publico(usuario_atualizado))


@bp.post("/foto")
@bp.post("/<int:alvo_id>/foto")
@requires_auth
def enviar_foto(alvo_id=None):
    """Sem id na URL: a pessoa troca a PRÓPRIA foto. Com id: um admin
    troca a de outra pessoa (ex.: padronizar as fotos da equipe, ou
    ajudar quem não sabe fazer). Usuário comum só mexe na própria."""
    usuario = g.usuario_atual
    if alvo_id is not None and alvo_id != usuario["id"] and not usuario["admin"]:
        raise ApiError("Só um administrador pode trocar a foto de outra pessoa.", status=403, codigo="sem_permissao")
    destino_id = alvo_id or usuario["id"]
    arquivo = request.files.get("foto")
    if not arquivo or not arquivo.filename:
        raise ApiError("Nenhuma imagem enviada.", status=400)
    ext = arquivo.filename.rsplit(".", 1)[-1].lower() if "." in arquivo.filename else ""
    if ext not in EXTENSOES_FOTO_PERMITIDAS:
        raise ApiError("Formato de imagem não suportado. Use jpg, png, gif ou webp.", status=400)

    dados_bytes = arquivo.read()
    if len(dados_bytes) > MAX_FOTO_MB * 1024 * 1024:
        raise ApiError(f"Imagem maior que o limite de {MAX_FOTO_MB}MB.", status=400)

    conn = get_db()
    anterior = conn.execute(
        "SELECT foto_perfil FROM usuarios WHERE id = ? AND empresa_id = ?", (destino_id, g.empresa_id)
    ).fetchone()
    if anterior is None:
        raise ApiError("Usuário não encontrado.", status=404, codigo="nao_encontrado")

    os.makedirs(PASTA_FOTOS, exist_ok=True)
    nome_seguro = f"{secrets.token_hex(8)}_{secure_filename(arquivo.filename)}"
    with open(os.path.join(PASTA_FOTOS, nome_seguro), "wb") as f:
        f.write(dados_bytes)
    url_foto = f"/api/v1/usuarios/fotos/{nome_seguro}"
    conn.execute("UPDATE usuarios SET foto_perfil = ? WHERE id = ?", (url_foto, destino_id))

    if anterior and anterior["foto_perfil"]:
        caminho_antigo = os.path.join(PASTA_FOTOS, os.path.basename(anterior["foto_perfil"]))
        if os.path.isfile(caminho_antigo):
            try:
                os.remove(caminho_antigo)
            except OSError:
                pass

    return jsonify({"foto_perfil": url_foto})


@bp.get("/fotos/<path:nome_arquivo>")
def baixar_foto(nome_arquivo):
    # Deliberadamente sem @requires_auth — servido por <img src> puro,
    # que não manda cabeçalho Authorization (mesmo raciocínio do
    # /whatsapp/uploads/<file>: o nome de arquivo com prefixo aleatório
    # de 16 hex já é a proteção contra acesso por adivinhação).
    # Sandbox + nosniff pelo mesmo motivo do /whatsapp/uploads: mesmo só
    # aceitando imagem no upload, servir do nosso endereço sem trava
    # deixaria qualquer arquivo aqui virar script rodando como se fosse
    # nosso.
    resp = send_from_directory(PASTA_FOTOS, nome_arquivo)
    resp.headers["X-Content-Type-Options"] = "nosniff"
    resp.headers["Content-Security-Policy"] = "sandbox; default-src 'none'"
    return resp
