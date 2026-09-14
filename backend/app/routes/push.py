"""
Notificação push (avisar mesmo com o app fechado) -- pedido do Clayton
(2026-09-14). O app já era instalável (PWA) de antes; isso liga a parte
que faltava.
"""
from flask import Blueprint, g, jsonify, request

from .. import push_service
from ..context import get_db, requires_auth

bp = Blueprint("push", __name__, url_prefix="/api/v1/push")


@bp.get("/chave-publica")
@requires_auth
def chave_publica():
    return jsonify({"chave": push_service.chave_publica(), "disponivel": push_service.push_disponivel()})


@bp.post("/inscrever")
@requires_auth
def inscrever():
    usuario = g.usuario_atual
    dados = request.get_json(silent=True) or {}
    conn = get_db()
    push_service.inscrever(conn, usuario["id"], dados.get("subscription") or {})
    return jsonify({"ok": True})


@bp.post("/desinscrever")
@requires_auth
def desinscrever():
    usuario = g.usuario_atual
    dados = request.get_json(silent=True) or {}
    conn = get_db()
    push_service.desinscrever(conn, usuario["id"], dados.get("endpoint") or "")
    return jsonify({"ok": True})


@bp.get("/minhas-inscricoes")
@requires_auth
def minhas_inscricoes():
    usuario = g.usuario_atual
    conn = get_db()
    return jsonify(push_service.listar_inscricoes_usuario(conn, usuario["id"]))
