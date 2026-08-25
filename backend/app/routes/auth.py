import datetime
import json

from flask import Blueprint, g, jsonify, request

from .. import limite_tentativas, security, transcricao, whatsapp_service
from ..context import ApiError, AuthError, get_db, requires_auth

bp = Blueprint("auth", __name__, url_prefix="/api/v1/auth")


def _chaves_limite(email):
    """Conta as tentativas por IP e por conta ao mesmo tempo (ver
    limite_tentativas). O IP real vem do X-Forwarded-For posto pelo
    proxy (Caddy) — confiável aqui porque a porta do app não é
    alcançável de fora, só o proxy fala com ele."""
    encaminhado = request.headers.get("X-Forwarded-For", "")
    ip = encaminhado.split(",")[0].strip() if encaminhado else (request.remote_addr or "?")
    return [f"ip:{ip}", f"conta:{email}"]


def _exigir_sem_bloqueio(chaves):
    espera = limite_tentativas.segundos_restantes(chaves)
    if espera > 0:
        raise ApiError(
            f"Muitas tentativas seguidas. Tente de novo em {max(1, espera // 60)} minuto(s).",
            status=429, codigo="muitas_tentativas",
        )


def _now_iso():
    return datetime.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def _dentro_do_horario_permitido(horario_permitido_json) -> bool:
    """Confere as janelas de horário liberado pro login (ex.: 08:00-12:00
    e 13:00-17:00). Sem restrição configurada = sempre liberado. Usa o
    horário local do servidor (é o mesmo fuso do escritório que configura
    os horários, diferente do resto do sistema que grava tudo em UTC)."""
    if not horario_permitido_json:
        return True
    try:
        janelas = json.loads(horario_permitido_json)
    except (ValueError, TypeError):
        return True
    if not janelas:
        return True
    agora = datetime.datetime.now().strftime("%H:%M")
    for janela in janelas:
        inicio, fim = janela.get("inicio"), janela.get("fim")
        if inicio and fim and inicio <= agora <= fim:
            return True
    return False


# Quanto tempo uma sessão vale sem precisar digitar a senha de novo. 30
# dias é o equilíbrio comum: ninguém fica relogando toda hora, mas um
# token que vaze não serve pra sempre.
SESSAO_VALIDA_DIAS = 30


def _sessao_expirada(criado_em) -> bool:
    if not criado_em:
        return False
    try:
        criada = datetime.datetime.strptime(criado_em, "%Y-%m-%dT%H:%M:%S.%fZ")
    except (ValueError, TypeError):
        return False  # formato estranho: não derruba a pessoa por isso
    return (datetime.datetime.utcnow() - criada).days >= SESSAO_VALIDA_DIAS


def _usuario_publico(u):
    return {
        "id": u["id"], "nome": u["nome"], "email": u["email"], "admin": bool(u["admin"]),
        "foto_perfil": u["foto_perfil"] if "foto_perfil" in u.keys() else None,
        "totp_ativado": bool(u["totp_ativado"]) if "totp_ativado" in u.keys() else False,
        # Só quem opera a plataforma vê a seção de backup (ver
        # requires_super_admin) — é informativo pro frontend esconder a
        # tela; quem barra de verdade é o servidor.
        "super_admin": bool(u["super_admin"]) if "super_admin" in u.keys() else False,
        # O frontend usa isto pra esconder o menu de Conversas de quem só
        # tem chat interno. Sem este campo aqui, o menu aparecia e a
        # pessoa só descobria o bloqueio ao clicar e levar 403.
        "acesso_conversas": bool(u["acesso_conversas"]) if "acesso_conversas" in u.keys() else True,
        "setor": u["setor"] if "setor" in u.keys() else None,
        "setores": whatsapp_service.setores_do_usuario(get_db(), u["id"]),
        # Pra tela não oferecer "transcrever" num servidor onde o
        # transcritor não foi instalado — o botão só apareceria pra
        # falhar.
        "transcricao_disponivel": transcricao.disponivel(),
    }


def _verificar_codigo_2fa(conn, usuario, codigo: str) -> bool:
    if security.verificar_totp(usuario["totp_secreto"], codigo):
        return True
    # não bateu como TOTP — tenta como código de recuperação de uso único
    codigos_hash = json.loads(usuario["totp_codigos_recuperacao"] or "[]")
    for i, h in enumerate(codigos_hash):
        if security.verify_password(codigo.strip(), h):
            restantes = codigos_hash[:i] + codigos_hash[i + 1:]
            conn.execute("UPDATE usuarios SET totp_codigos_recuperacao = ? WHERE id = ?", (json.dumps(restantes), usuario["id"]))
            return True
    return False


def _emitir_sessao(conn, usuario_id, dispositivo=None, criado_em=None):
    """criado_em preserva a data do login ORIGINAL quando a sessão é
    renovada. Sem isso o prazo de validade se renovaria junto com o
    token a cada renovação e a sessão nunca expiraria de verdade — que é
    justamente o que se quer evitar caso um token vaze."""
    access_token = security.emitir_access_token(usuario_id)
    refresh_token = security.gerar_refresh_token()
    conn.execute(
        "INSERT INTO sessoes (usuario_id, refresh_token_hash, criado_em, dispositivo) VALUES (?, ?, ?, ?)",
        (usuario_id, security.hash_refresh_token(refresh_token), criado_em or _now_iso(), dispositivo),
    )
    return access_token, refresh_token


@bp.post("/login")
def login():
    dados = request.get_json(silent=True) or {}
    email = (dados.get("email") or "").strip().lower()
    senha = dados.get("senha") or ""
    if not email or not senha:
        raise ApiError("Informe email e senha.", status=400)

    chaves = _chaves_limite(email)
    _exigir_sem_bloqueio(chaves)

    conn = get_db()
    usuario = conn.execute("SELECT * FROM usuarios WHERE email = ?", (email,)).fetchone()
    if usuario is None or not security.verify_password(senha, usuario["senha_hash"]):
        limite_tentativas.registrar_falha(chaves)
        raise AuthError("Email ou senha incorretos.")
    if not usuario["ativo"]:
        raise AuthError("Usuário inativo.")
    horario_permitido = usuario["horario_permitido"] if "horario_permitido" in usuario.keys() else None
    if not usuario["admin"] and not _dentro_do_horario_permitido(horario_permitido):
        janelas = ", ".join(f"{j['inicio']}–{j['fim']}" for j in json.loads(horario_permitido))
        raise AuthError(f"Fora do horário de acesso permitido ({janelas}).")

    if usuario["totp_ativado"]:
        codigo_2fa = (dados.get("codigo_2fa") or "").strip()
        if not codigo_2fa:
            # Senha certa, mas ainda falta o segundo fator — devolve um
            # sinal específico (sem tokens) pro frontend pedir o código,
            # em vez de um erro genérico.
            return jsonify({"requer_2fa": True})
        if not _verificar_codigo_2fa(conn, usuario, codigo_2fa):
            # Conta junto com a senha: são só 6 dígitos, sem freio dava
            # pra varrer todos rapidinho depois de descobrir a senha.
            limite_tentativas.registrar_falha(chaves)
            raise AuthError("Código de verificação incorreto.")

    limite_tentativas.registrar_sucesso(chaves)
    dispositivo = request.headers.get("User-Agent", "")[:255]
    access_token, refresh_token = _emitir_sessao(conn, usuario["id"], dispositivo)
    whatsapp_service.registrar_atividade(conn, usuario["id"], "login")
    return jsonify({
        "access_token": access_token,
        "refresh_token": refresh_token,
        "token_type": "Bearer",
        "usuario": _usuario_publico(usuario),
    })


@bp.post("/refresh")
def refresh():
    dados = request.get_json(silent=True) or {}
    refresh_token = dados.get("refresh_token") or ""
    if not refresh_token:
        raise ApiError("Informe refresh_token.", status=400)

    conn = get_db()
    token_hash = security.hash_refresh_token(refresh_token)
    sessao = conn.execute(
        "SELECT * FROM sessoes WHERE refresh_token_hash = ? AND revogado = 0", (token_hash,)
    ).fetchone()
    if sessao is None:
        raise AuthError("Sessão inválida ou encerrada — faça login novamente.")

    # Sessão tem prazo de validade: sem isso, um refresh token que vazasse
    # daria acesso pra sempre, porque ele só morria se alguém lembrasse de
    # revogar. Passou do prazo, tem que logar de novo.
    if _sessao_expirada(sessao["criado_em"]):
        conn.execute("UPDATE sessoes SET revogado = 1 WHERE id = ?", (sessao["id"],))
        raise AuthError("Sessão expirada — faça login novamente.")

    usuario = conn.execute("SELECT * FROM usuarios WHERE id = ?", (sessao["usuario_id"],)).fetchone()
    if usuario is None or not usuario["ativo"]:
        raise AuthError("Usuário não encontrado ou inativo.")

    # Rotaciona o refresh token (revoga o antigo, emite um novo) — reduz
    # a janela de uso caso um refresh token antigo tenha vazado.
    conn.execute("UPDATE sessoes SET revogado = 1 WHERE id = ?", (sessao["id"],))
    access_token, novo_refresh = _emitir_sessao(
        conn, usuario["id"], sessao["dispositivo"], criado_em=sessao["criado_em"]
    )
    return jsonify({"access_token": access_token, "refresh_token": novo_refresh, "token_type": "Bearer"})


@bp.post("/logout")
def logout():
    dados = request.get_json(silent=True) or {}
    refresh_token = dados.get("refresh_token") or ""
    if refresh_token:
        conn = get_db()
        token_hash = security.hash_refresh_token(refresh_token)
        sessao = conn.execute("SELECT usuario_id FROM sessoes WHERE refresh_token_hash = ?", (token_hash,)).fetchone()
        conn.execute("UPDATE sessoes SET revogado = 1 WHERE refresh_token_hash = ?", (token_hash,))
        if sessao:
            # Sair do sistema derruba o status na hora. Sem isto a pessoa
            # continuaria "atendendo" até o tempo de MINUTOS_ONLINE
            # vencer, e o cliente seria direcionado pra quem já foi
            # embora. Só derruba se não tiver outra sessão ativa (ex.:
            # deslogou no computador mas continua no celular).
            outra_sessao = conn.execute(
                "SELECT 1 FROM sessoes WHERE usuario_id = ? AND revogado = 0 LIMIT 1", (sessao["usuario_id"],)
            ).fetchone()
            if not outra_sessao:
                conn.execute("UPDATE usuarios SET ultimo_acesso = NULL WHERE id = ?", (sessao["usuario_id"],))
            whatsapp_service.registrar_atividade(conn, sessao["usuario_id"], "logout")
    return jsonify({"ok": True})


@bp.get("/me")
@requires_auth
def me():
    return jsonify(_usuario_publico(g.usuario_atual))


@bp.post("/senha")
@requires_auth
def trocar_senha():
    """Cada usuário troca a própria senha (o admin só define a inicial ao
    criar a conta — depois disso é autosserviço, como o resto do
    sistema: foto de perfil, 2FA)."""
    usuario = g.usuario_atual
    dados = request.get_json(silent=True) or {}
    senha_atual = dados.get("senha_atual") or ""
    senha_nova = dados.get("senha_nova") or ""
    conn = get_db()
    row = conn.execute("SELECT senha_hash FROM usuarios WHERE id = ?", (usuario["id"],)).fetchone()
    if not security.verify_password(senha_atual, row["senha_hash"]):
        raise AuthError("Senha atual incorreta.")
    problemas = security.validar_politica_senha(senha_nova)
    if problemas:
        raise ApiError(" ".join(problemas), status=400)
    conn.execute("UPDATE usuarios SET senha_hash = ? WHERE id = ?", (security.hash_password(senha_nova), usuario["id"]))
    # Revoga todas as sessões (inclusive a atual) — trocar a senha deve
    # sempre exigir logar de novo com ela, em qualquer aparelho.
    conn.execute("UPDATE sessoes SET revogado = 1 WHERE usuario_id = ?", (usuario["id"],))
    whatsapp_service.registrar_atividade(conn, usuario["id"], "senha_alterada")
    return jsonify({"ok": True})


# ============================================================
# 2FA — cada usuário ativa/desativa a própria (não é o admin que liga
# pra outra pessoa, mesma lógica da foto de perfil)
# ============================================================
@bp.post("/2fa/iniciar")
@requires_auth
def iniciar_2fa():
    usuario = g.usuario_atual
    if usuario["totp_ativado"]:
        raise ApiError("A verificação em duas etapas já está ativada.", status=400)
    secreto = security.gerar_totp_secreto()
    conn = get_db()
    conn.execute("UPDATE usuarios SET totp_secreto = ? WHERE id = ?", (secreto, usuario["id"]))
    return jsonify({"secreto": secreto, "uri": security.gerar_totp_uri(secreto, usuario["email"])})


@bp.post("/2fa/confirmar")
@requires_auth
def confirmar_2fa():
    usuario = g.usuario_atual
    dados = request.get_json(silent=True) or {}
    codigo = (dados.get("codigo") or "").strip()
    conn = get_db()
    row = conn.execute("SELECT totp_secreto FROM usuarios WHERE id = ?", (usuario["id"],)).fetchone()
    if not row["totp_secreto"]:
        raise ApiError("Inicie o cadastro da verificação em duas etapas primeiro.", status=400)
    if not security.verificar_totp(row["totp_secreto"], codigo):
        raise ApiError("Código incorreto — confira se o horário do celular está certo e tente de novo.", status=400)
    codigos = security.gerar_codigos_recuperacao()
    conn.execute(
        "UPDATE usuarios SET totp_ativado = 1, totp_codigos_recuperacao = ? WHERE id = ?",
        (json.dumps([security.hash_password(c) for c in codigos]), usuario["id"]),
    )
    whatsapp_service.registrar_atividade(conn, usuario["id"], "2fa_ativado")
    return jsonify({"ok": True, "codigos_recuperacao": codigos})


@bp.post("/2fa/desativar")
@requires_auth
def desativar_2fa():
    usuario = g.usuario_atual
    dados = request.get_json(silent=True) or {}
    senha = dados.get("senha") or ""
    conn = get_db()
    row = conn.execute("SELECT senha_hash FROM usuarios WHERE id = ?", (usuario["id"],)).fetchone()
    if not security.verify_password(senha, row["senha_hash"]):
        raise AuthError("Senha incorreta.")
    conn.execute(
        "UPDATE usuarios SET totp_ativado = 0, totp_secreto = NULL, totp_codigos_recuperacao = NULL WHERE id = ?",
        (usuario["id"],),
    )
    whatsapp_service.registrar_atividade(conn, usuario["id"], "2fa_desativado")
    return jsonify({"ok": True})
