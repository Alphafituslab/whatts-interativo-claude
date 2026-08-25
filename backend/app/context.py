"""
Contexto de requisição: conexão de banco por requisição e resolução do
usuário autenticado a partir do JWT enviado no header Authorization.
"""
import datetime
import sqlite3

from flask import g, request

from . import db as db_module
from . import security


class ApiError(Exception):
    def __init__(self, mensagem, status=400, codigo="erro"):
        super().__init__(mensagem)
        self.mensagem = mensagem
        self.status = status
        self.codigo = codigo


class AuthError(ApiError):
    def __init__(self, mensagem="Não autenticado."):
        super().__init__(mensagem, status=401, codigo="nao_autenticado")


class ForbiddenError(ApiError):
    def __init__(self, mensagem="Você não tem permissão para executar esta ação."):
        super().__init__(mensagem, status=403, codigo="sem_permissao")


def get_db() -> sqlite3.Connection:
    if "db_conn" not in g:
        g.db_conn = db_module._connect()
    return g.db_conn


def close_db(exception=None):
    conn = g.pop("db_conn", None)
    if conn is not None:
        if exception is None:
            conn.commit()
        else:
            conn.rollback()
        conn.close()


def get_current_user() -> dict:
    auth_header = request.headers.get("Authorization", "")
    if not auth_header.startswith("Bearer "):
        raise AuthError("Token de acesso ausente.")
    token = auth_header[len("Bearer "):].strip()

    try:
        payload = security.decodificar_token(token)
    except Exception:
        raise AuthError("Token de acesso inválido ou expirado.")

    if payload.get("tipo") != "access":
        raise AuthError("Tipo de token inválido para esta operação.")

    usuario_id = int(payload["sub"])
    conn = get_db()
    row = conn.execute("SELECT * FROM usuarios WHERE id = ?", (usuario_id,)).fetchone()
    if row is None:
        raise AuthError("Usuário não encontrado.")
    usuario = dict(row)
    if not usuario["ativo"]:
        raise AuthError("Usuário inativo.")

    _marcar_online(conn, usuario)

    g.usuario_atual = usuario
    g.empresa_id = usuario["empresa_id"]
    return usuario


def _marcar_online(conn, usuario):
    """Atualiza usuarios.ultimo_acesso pra saber quem está 'online' agora
    (usado pelo menu de atendimento por setor). Só grava se fizer mais de
    60s desde o último registro — o frontend faz polling frequente, então
    escrever a cada request seria banco de dados batendo sem necessidade."""
    agora = datetime.datetime.utcnow()
    anterior_str = usuario.get("ultimo_acesso")
    if anterior_str:
        try:
            anterior = datetime.datetime.strptime(anterior_str, "%Y-%m-%dT%H:%M:%S.%fZ")
            if (agora - anterior).total_seconds() < 60:
                return
        except ValueError:
            pass
    agora_iso = agora.strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"
    conn.execute("UPDATE usuarios SET ultimo_acesso = ? WHERE id = ?", (agora_iso, usuario["id"]))
    usuario["ultimo_acesso"] = agora_iso


def requires_auth(view_func):
    import functools

    @functools.wraps(view_func)
    def wrapper(*args, **kwargs):
        get_current_user()
        return view_func(*args, **kwargs)

    return wrapper


def requires_conversas(view_func):
    """Barra quem só tem acesso ao chat interno.

    Não basta esconder o menu: sem esta trava, bastaria digitar o
    endereço da conversa (ou chamar a API direto) pra ler o atendimento
    dos clientes. Administrador passa sempre — quem administra vê tudo.
    """
    import functools

    @functools.wraps(view_func)
    def wrapper(*args, **kwargs):
        usuario = get_current_user()
        liberado = "acesso_conversas" not in usuario.keys() or usuario["acesso_conversas"]
        if not usuario["admin"] and not liberado:
            raise ForbiddenError("Seu acesso é só ao chat interno. Peça a um administrador para liberar as conversas.")
        return view_func(*args, **kwargs)

    return wrapper


def requires_admin(view_func):
    import functools

    @functools.wraps(view_func)
    def wrapper(*args, **kwargs):
        usuario = get_current_user()
        if not usuario["admin"]:
            raise ForbiddenError("Só um administrador pode executar esta ação.")
        return view_func(*args, **kwargs)

    return wrapper


def requires_super_admin(view_func):
    """Ações que atingem o sistema INTEIRO, não só uma empresa — hoje,
    backup e restauração (o backup é do banco todo, com os dados de
    todas as empresas juntos). Um admin comum é dono da SUA empresa; se
    ele pudesse baixar/restaurar o backup, alcançaria os dados das
    outras empresas e poderia desfazer o trabalho delas."""
    import functools

    @functools.wraps(view_func)
    def wrapper(*args, **kwargs):
        usuario = get_current_user()
        eh_super = "super_admin" in usuario.keys() and usuario["super_admin"]
        if not eh_super:
            raise ForbiddenError("Esta ação é restrita a quem administra a plataforma.")
        return view_func(*args, **kwargs)

    return wrapper
