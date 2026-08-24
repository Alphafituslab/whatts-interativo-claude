"""
Primitivas de segurança — hashlib/hmac/secrets (biblioteca padrão) mais
PyJWT. PBKDF2-HMAC-SHA256 com 200.000 iterações é uma prática reconhecida
e segura para hash de senha.
"""
import hashlib
import hmac
import secrets
import time

import jwt
import pyotp

PBKDF2_ITERATIONS = 200_000


def hash_password(senha: str) -> str:
    salt = secrets.token_bytes(16)
    derived = hashlib.pbkdf2_hmac("sha256", senha.encode("utf-8"), salt, PBKDF2_ITERATIONS)
    return f"pbkdf2_sha256${PBKDF2_ITERATIONS}${salt.hex()}${derived.hex()}"


def verify_password(senha: str, senha_hash: str) -> bool:
    try:
        algo, iterations_s, salt_hex, hash_hex = senha_hash.split("$")
        if algo != "pbkdf2_sha256":
            return False
        iterations = int(iterations_s)
        salt = bytes.fromhex(salt_hex)
        expected = bytes.fromhex(hash_hex)
    except (ValueError, AttributeError):
        return False
    derived = hashlib.pbkdf2_hmac("sha256", senha.encode("utf-8"), salt, iterations)
    return hmac.compare_digest(derived, expected)


def validar_politica_senha(senha: str):
    problemas = []
    if len(senha) < 10:
        problemas.append("A senha deve ter no mínimo 10 caracteres.")
    if not any(c.isalpha() for c in senha):
        problemas.append("A senha deve conter ao menos uma letra.")
    if not any(c.isdigit() for c in senha):
        problemas.append("A senha deve conter ao menos um número.")
    return problemas


ACCESS_TOKEN_TTL_SECONDS = 30 * 60


def _get_jwt_secret() -> str:
    import os
    secret = os.environ.get("WPP_JWT_SECRET")
    if not secret:
        raise RuntimeError(
            "WPP_JWT_SECRET não configurado. Defina uma chave secreta forte de ambiente antes de iniciar o servidor."
        )
    return secret


def emitir_access_token(usuario_id: int) -> str:
    now = int(time.time())
    payload = {"sub": str(usuario_id), "tipo": "access", "iat": now, "exp": now + ACCESS_TOKEN_TTL_SECONDS}
    return jwt.encode(payload, _get_jwt_secret(), algorithm="HS256")


def decodificar_token(token: str) -> dict:
    return jwt.decode(token, _get_jwt_secret(), algorithms=["HS256"])


def gerar_refresh_token() -> str:
    return secrets.token_urlsafe(48)


def hash_refresh_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


# ============================================================
# 2FA (TOTP — Google Authenticator, Authy, etc.)
# ============================================================
def gerar_totp_secreto() -> str:
    return pyotp.random_base32()


def gerar_totp_uri(secreto: str, email: str, emissor: str = "Seja Alpha") -> str:
    return pyotp.TOTP(secreto).provisioning_uri(name=email, issuer_name=emissor)


def verificar_totp(secreto: str, codigo: str) -> bool:
    if not secreto or not codigo:
        return False
    try:
        return pyotp.TOTP(secreto).verify(codigo.strip(), valid_window=1)
    except Exception:
        return False


def gerar_codigos_recuperacao(quantidade: int = 8):
    """Códigos de uso único pra quando a pessoa perde acesso ao app
    autenticador — formato curto (fácil de digitar/anotar), mas com
    entropia suficiente (8 chars hex = 32 bits) já que cada um só serve
    uma vez e a conta continua protegida por senha."""
    return [secrets.token_hex(4) for _ in range(quantidade)]
