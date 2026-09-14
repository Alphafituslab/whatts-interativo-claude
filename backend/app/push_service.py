"""
Notificação push no navegador/celular -- pedido do Clayton (2026-09-14):
hoje TODO aviso do sistema (Follow-up, números monitorados, proposta
parada, nova mensagem...) só chega com a aba aberta -- a pessoa usa
`new Notification()` no JS, que exige o site carregado na tela. Isso
aqui usa a Web Push API de verdade: o navegador entrega a notificação
mesmo com o site fechado, através do service worker (que já existia
antes, pra tornar o app instalável -- ver frontend/sw.js).

Assinatura (VAPID): a chave PRIVADA fica em backend/data/vapid_private.pem
(fora do git, mesma pasta ignorada onde já mora o banco). A chave
PÚBLICA não é segredo -- é enviada pro navegador de propósito, é assim
que a Web Push funciona -- por isso fica hardcoded aqui embaixo.
"""
import datetime
import os

from .context import ApiError

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_VAPID_PATH = os.path.join(BASE_DIR, "data", "vapid_private.pem")
VAPID_PUBLIC_KEY = "BB56Tujcmducz-j3x3GixC8QFoLKG_5zqpwL_Xrjr-tWTqLw-N8AfR8EQeRZwsDI7MpCWBZZ78jiTtXVuwG8vo0"
VAPID_CLAIMS_SUB = "mailto:suporte@alphafitus.com.br"


def _now_iso():
    return datetime.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def _vapid_path():
    return os.environ.get("WPP_VAPID_PRIVATE_KEY_PATH", DEFAULT_VAPID_PATH)


def push_disponivel() -> bool:
    return os.path.isfile(_vapid_path())


def chave_publica():
    return VAPID_PUBLIC_KEY


def inscrever(conn, usuario_id: int, subscription: dict):
    endpoint = (subscription or {}).get("endpoint")
    keys = (subscription or {}).get("keys") or {}
    p256dh = keys.get("p256dh")
    auth = keys.get("auth")
    if not endpoint or not p256dh or not auth:
        raise ApiError("Inscrição de notificação inválida.", status=400)
    conn.execute(
        """
        INSERT INTO whatsapp_push_subscricoes (usuario_id, endpoint, p256dh, auth, criado_em)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(endpoint) DO UPDATE SET
            usuario_id = excluded.usuario_id,
            p256dh = excluded.p256dh,
            auth = excluded.auth
        """,
        (usuario_id, endpoint, p256dh, auth, _now_iso()),
    )
    conn.commit()


def desinscrever(conn, usuario_id: int, endpoint: str):
    conn.execute(
        "DELETE FROM whatsapp_push_subscricoes WHERE usuario_id = ? AND endpoint = ?",
        (usuario_id, endpoint),
    )
    conn.commit()


def listar_inscricoes_usuario(conn, usuario_id: int):
    return [dict(r) for r in conn.execute(
        "SELECT id, endpoint, criado_em FROM whatsapp_push_subscricoes WHERE usuario_id = ?", (usuario_id,)
    ).fetchall()]


def enviar_push(conn, usuario_id: int, titulo: str, corpo: str, tag: str = None, url: str = None):
    """Manda a notificação de verdade pros aparelhos inscritos desse
    usuário. Nunca derruba quem chamou -- se a Web Push falhar (sem
    chave configurada, aparelho desinstalou o app, etc.) só ignora e
    segue o baile; os avisos dentro do app (flash/som) continuam
    funcionando do jeito de sempre, isso aqui é um extra."""
    if not push_disponivel():
        return 0
    import json as _json
    from pywebpush import webpush, WebPushException

    inscricoes = conn.execute(
        "SELECT id, endpoint, p256dh, auth FROM whatsapp_push_subscricoes WHERE usuario_id = ?", (usuario_id,)
    ).fetchall()
    if not inscricoes:
        return 0
    payload = _json.dumps({"title": titulo, "body": corpo, "tag": tag or "whatts", "url": url or "/"})
    enviados = 0
    for insc in inscricoes:
        subscription_info = {
            "endpoint": insc["endpoint"],
            "keys": {"p256dh": insc["p256dh"], "auth": insc["auth"]},
        }
        try:
            webpush(
                subscription_info=subscription_info,
                data=payload,
                vapid_private_key=_vapid_path(),
                vapid_claims={"sub": VAPID_CLAIMS_SUB},
            )
            enviados += 1
        except WebPushException as erro:
            codigo = getattr(erro.response, "status_code", None)
            if codigo in (404, 410):
                # Inscrição morta (desinstalou o app, trocou de celular,
                # navegador revogou) -- limpa pra não tentar de novo.
                conn.execute("DELETE FROM whatsapp_push_subscricoes WHERE id = ?", (insc["id"],))
                conn.commit()
        except Exception:
            pass
    return enviados
