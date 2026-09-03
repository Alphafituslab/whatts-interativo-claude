"""
Página de downloads (instaladores e ferramentas).

Antes isso era uma pasta estática servida pelo Caddy, com uma senha fixa
escrita no Caddyfile. Virou rota do Flask por um pedido simples: usar o
MESMO login e senha do sistema. Assim não existe segunda senha pra
lembrar, e trocar a senha (ou o email) no sistema já vale aqui — não tem
nada pra sincronizar à mão.

Como a página é aberta digitando o endereço no navegador (e não pelo app,
que manda o token no cabeçalho), a sessão daqui é um cookie assinado
próprio, curto, separado do token do app.
"""
import io
import os
import re
import time
import zipfile

import jwt
from flask import Blueprint, make_response, redirect, request, send_file, send_from_directory

from .. import VERSAO_SERVIDOR, security
from ..context import get_db, requires_auth

bp = Blueprint("downloads", __name__, url_prefix="/downloads")

# Pasta com os arquivos grandes (instalador do Alphafitus OS, DB Browser).
# Fica fora do repositório de propósito: são binários de dezenas de MB,
# alguns de outros produtos.
ARQUIVOS_DIR = os.environ.get("WPP_DOWNLOADS_DIR", "/opt/alphafitus-downloads")
INSTALADOR_DIR = os.path.abspath(
    os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "..", "instalador")
)

COOKIE = "whatts_downloads"
SESSAO_SEGUNDOS = 8 * 60 * 60


def _emitir_cookie(usuario_id: int) -> str:
    agora = int(time.time())
    return jwt.encode(
        {"sub": str(usuario_id), "tipo": "downloads", "iat": agora, "exp": agora + SESSAO_SEGUNDOS},
        security._get_jwt_secret(),
        algorithm="HS256",
    )


def _usuario_logado():
    token = request.cookies.get(COOKIE)
    if not token:
        return None
    try:
        dados = jwt.decode(token, security._get_jwt_secret(), algorithms=["HS256"])
        if dados.get("tipo") != "downloads":
            return None
    except jwt.PyJWTError:
        return None
    return get_db().execute(
        "SELECT id, nome, email, admin FROM usuarios WHERE id = ? AND ativo = 1", (dados["sub"],)
    ).fetchone()


def _escapar(texto: str) -> str:
    """O nome vem do cadastro, mas vai parar dentro do HTML — escapar é
    barato e evita que um nome com < ou & quebre (ou pior) a página."""
    return (str(texto or "")
            .replace("&", "&amp;").replace("<", "&lt;")
            .replace(">", "&gt;").replace('"', "&quot;"))


def _versao_por_data_do_arquivo(nome_arquivo: str) -> str:
    """Combina o número de versão REAL (se o outro sistema deixou um
    arquivo ".versao" ao lado do instalador -- ver ALPHAFITUS_Backend/
    installer, que grava isso a cada deploy) com a data/hora em que o
    arquivo foi trocado pela última vez aqui no servidor. Sem o arquivo
    ".versao" (produto que não tem esse número disponível), cai de volta
    só na data/hora -- nunca inventa um número."""
    caminho = os.path.join(ARQUIVOS_DIR, nome_arquivo)
    try:
        import datetime
        try:
            from zoneinfo import ZoneInfo
            fuso = ZoneInfo("America/Sao_Paulo")
        except Exception:
            fuso = datetime.timezone.utc
        mtime = datetime.datetime.fromtimestamp(os.path.getmtime(caminho), tz=fuso)
        data_hora = mtime.strftime("%d/%m/%Y às %H:%M")
    except OSError:
        return "indisponível"

    versao_real = None
    try:
        with open(caminho + ".versao", encoding="utf-8") as f:
            versao_real = f.read().strip()
    except OSError:
        pass

    if versao_real:
        return f"v{versao_real} — atualizado em {data_hora}"
    return f"atualizado em {data_hora}"


def _formatar_versao_servidor_legivel() -> str:
    """VERSAO_SERVIDOR é "2026.08.31.163528" (formato compacto -- ver
    app/__init__.py, também usado pra invalidar cache). Aqui reformata só
    pra exibição, no mesmo "31/08/2026 às 16:35" usado pro Alphafitus OS."""
    import datetime
    try:
        momento = datetime.datetime.strptime(VERSAO_SERVIDOR, "%Y.%m.%d.%H%M%S")
        return momento.strftime("%d/%m/%Y às %H:%M")
    except ValueError:
        return VERSAO_SERVIDOR


def _pagina(nome_arquivo: str):
    pasta = os.path.dirname(os.path.abspath(__file__))
    caminho = os.path.abspath(os.path.join(pasta, "..", "..", "..", "deploy", "downloads", nome_arquivo))
    with open(caminho, encoding="utf-8") as f:
        return f.read()


def _tela_login(erro: str = None):
    html = _pagina("login.html").replace(
        "<!--ERRO-->",
        f'<p class="erro">{erro}</p>' if erro else "",
    )
    resposta = make_response(html)
    resposta.headers["Cache-Control"] = "no-store"
    return resposta, (401 if erro else 200)


# Arquivos que só administrador pode baixar. O instalador do atalho é
# pra equipe inteira; a ferramenta de banco não — ela vem junto com o
# endereço do servidor e o caminho do arquivo do banco.
SO_ADMIN = ("DBBrowserForSQLite-instalador.msi", "AlphafitusOS_ChaveBanco.txt")

# Onde a compilação deixa o APK. Servido de lá direto, sem cópia: assim
# uma recompilação já entrega a versão nova, sem ninguém lembrar de
# copiar arquivo.
APK_DIR = os.environ.get("WPP_APK_DIR", "/opt/apk-sejaalpha")
APK_NOME = "app-release-signed.apk"


@bp.get("/SejaAlpha.apk")
def baixar_apk():
    """App do Android. Fica atrás do mesmo login do resto da página —
    é o sistema da empresa, não um app público."""
    if _usuario_logado() is None:
        return redirect("/downloads/")
    caminho = os.path.join(APK_DIR, APK_NOME)
    if not os.path.exists(caminho):
        return redirect("/downloads/")
    return send_file(caminho, mimetype="application/vnd.android.package-archive",
                     as_attachment=True, download_name="SejaAlpha.apk", max_age=0)


def apk_existe() -> bool:
    return os.path.exists(os.path.join(APK_DIR, APK_NOME))


@bp.get("/")
@bp.get("")
def pagina():
    usuario = _usuario_logado()
    if usuario is None:
        html, status = _tela_login()
        return html, status
    html = _pagina("index.html")
    html = html.replace("<!--NOME-->", _escapar(usuario["nome"] or usuario["email"]))
    # Seja Alpha é montado na hora a partir DESTE mesmo servidor -- é o
    # mesmo instante que aparece em /api/v1/versao, só reformatado pra
    # leitura ("31/08/2026 às 16:35" em vez de "2026.08.31.163528").
    html = html.replace("<!--VERSAO_SEJAALPHA-->", f"atualizado em {_formatar_versao_servidor_legivel()}")
    # Alphafitus OS é outro produto (outro repositório) hospedado aqui
    # só como arquivo -- não tem número de versão próprio disponível
    # neste sistema. A data/hora da última vez que o .exe foi trocado no
    # servidor é o que dá pra saber com certeza sem inventar número.
    html = html.replace("<!--VERSAO_ALPHAFITUS-->", _versao_por_data_do_arquivo("AlphafitusOS_Servidor_Instalar.exe"))
    html = html.replace("<!--VERSAO_MANUAL-->", _versao_por_data_do_arquivo("Manual_AlphafitusOS.html"))
    if not apk_existe():
        html = re.sub(r"<!--APK-->.*?<!--/APK-->", "", html, flags=re.S)
    if not usuario["admin"]:
        # O bloco de ferramentas técnicas mostra IP do servidor, usuário
        # root e onde fica o arquivo do banco. Colaborador entra pra
        # pegar o instalador; nada disso precisa aparecer pra ele.
        html = re.sub(r"<!--ADMIN-->.*?<!--/ADMIN-->", "", html, flags=re.S)
    return html


@bp.post("/sso")
@requires_auth
def sso():
    """Login automático nesta página pra quem já está logado no app.

    Sem isso, clicar em "Baixar" de dentro do próprio Seja Alpha (na
    barra lateral, ou no modal de instalar no celular) caía na tela de
    email/senha desta página -- confuso, já que a pessoa tinha acabado
    de logar. O token normal do app (Bearer, no cabeçalho) já prova
    quem é; aqui só troca isso pelo cookie de sessão que este módulo
    usa, pra um <a href> comum já baixar o arquivo direto."""
    from flask import g, jsonify
    resposta = make_response(jsonify({"ok": True}))
    resposta.set_cookie(
        COOKIE, _emitir_cookie(g.usuario_atual["id"]),
        max_age=SESSAO_SEGUNDOS, httponly=True, secure=True, samesite="Lax", path="/",
    )
    return resposta


@bp.post("/entrar")
def entrar():
    email = (request.form.get("email") or "").strip().lower()
    senha = request.form.get("senha") or ""
    conn = get_db()
    row = conn.execute(
        "SELECT id, senha_hash, ativo FROM usuarios WHERE lower(email) = ?", (email,)
    ).fetchone()
    # Mensagem única e genérica de propósito: dizer "esse email não
    # existe" entregaria quais emails são válidos pra quem estiver
    # chutando.
    if row is None or not row["ativo"] or not security.verify_password(senha, row["senha_hash"]):
        html, status = _tela_login("Email ou senha inválidos.")
        return html, status
    resposta = make_response(redirect("/downloads/"))
    resposta.set_cookie(
        COOKIE, _emitir_cookie(row["id"]),
        max_age=SESSAO_SEGUNDOS, httponly=True, secure=True, samesite="Lax", path="/",
    )
    return resposta


@bp.get("/sair")
def sair():
    resposta = make_response(redirect("/downloads/"))
    resposta.delete_cookie(COOKIE, path="/")
    return resposta


@bp.get("/WhattsInbox-instalador.zip")
def instalador_whatts():
    """Montado na hora, a partir da pasta instalador/ do repositório —
    assim nunca existe um ZIP velho esquecido em algum canto."""
    if _usuario_logado() is None:
        return redirect("/downloads/")
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as z:
        for nome in sorted(os.listdir(INSTALADOR_DIR)):
            caminho = os.path.join(INSTALADOR_DIR, nome)
            if os.path.isfile(caminho):
                z.write(caminho, nome)
    buffer.seek(0)
    return send_file(
        buffer, mimetype="application/zip", as_attachment=True,
        download_name="WhattsInbox-instalador.zip", max_age=0,
    )


@bp.get("/<path:arquivo>")
def baixar(arquivo):
    usuario = _usuario_logado()
    if usuario is None:
        return redirect("/downloads/")
    if arquivo in SO_ADMIN and not usuario["admin"]:
        return redirect("/downloads/")
    # send_from_directory já barra "..", mas a checagem explícita deixa
    # claro que nada fora desta pasta pode ser servido.
    if "/" in arquivo or "\\" in arquivo:
        return redirect("/downloads/")
    return send_from_directory(ARQUIVOS_DIR, arquivo, max_age=0)
