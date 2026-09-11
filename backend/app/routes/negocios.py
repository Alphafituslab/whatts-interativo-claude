"""
CRM de vendas (funil) — pedido do Clayton (2026-09-11).

Visibilidade segue a mesma régua do resto do sistema: cada um vê os
negócios que são dele (responsável); admin vê tudo e pode filtrar por
pessoa (?responsavel_id=N), igual já faz no Follow-up.
"""
from flask import Blueprint, g, jsonify, request

from .. import negocio_service
from ..context import ApiError, get_db, requires_auth

bp = Blueprint("negocios", __name__, url_prefix="/api/v1/negocios")


def _escopo():
    usuario = g.usuario_atual
    if usuario["admin"]:
        pedido = request.args.get("responsavel_id")
        if pedido:
            try:
                return int(pedido)
            except ValueError:
                raise ApiError("Responsável inválido.", status=400)
        return None
    return usuario["id"]


def _pode_mexer(usuario, negocio):
    return bool(usuario["admin"] or negocio["responsavel_usuario_id"] == usuario["id"]
                or negocio["criado_por_id"] == usuario["id"])


@bp.get("")
@requires_auth
def listar():
    conn = get_db()
    itens = negocio_service.listar(conn, g.empresa_id, _escopo())
    return jsonify(itens)


@bp.get("/resumo")
@requires_auth
def resumo():
    conn = get_db()
    return jsonify(negocio_service.funil_resumo(conn, g.empresa_id, _escopo()))


@bp.get("/estagios")
@requires_auth
def estagios():
    """Metadados fixos do funil (chave/nome/cor) — o Kanban monta as
    colunas a partir daqui, sem precisar hardcodar no frontend."""
    return jsonify(negocio_service.ESTAGIOS_FUNIL)


@bp.post("")
@requires_auth
def criar():
    usuario = g.usuario_atual
    dados = request.get_json(silent=True) or {}
    contato_id = dados.get("contato_id")
    if not contato_id:
        raise ApiError("Escolha o contato desse negócio.", status=400)
    conn = get_db()
    contato = conn.execute(
        "SELECT id FROM whatsapp_contatos WHERE id = ? AND empresa_id = ?", (contato_id, g.empresa_id)
    ).fetchone()
    if contato is None:
        raise ApiError("Contato não encontrado.", status=404, codigo="nao_encontrado")
    conversa_id = dados.get("conversa_id")
    if conversa_id:
        conversa = conn.execute(
            "SELECT c.id FROM whatsapp_conversas c JOIN whatsapp_contatos ct ON ct.id = c.contato_id "
            "WHERE c.id = ? AND ct.empresa_id = ?", (conversa_id, g.empresa_id),
        ).fetchone()
        if conversa is None:
            raise ApiError("Conversa não encontrada.", status=404, codigo="nao_encontrado")
    valor = dados.get("valor")
    if valor not in (None, ""):
        try:
            valor = float(valor)
        except (TypeError, ValueError):
            raise ApiError("Valor inválido.", status=400)
    else:
        valor = None
    responsavel_usuario_id = dados.get("responsavel_usuario_id") or usuario["id"]
    negocio_id = negocio_service.criar(
        conn, g.empresa_id, contato_id, conversa_id, (dados.get("titulo") or "").strip() or None,
        valor, responsavel_usuario_id, usuario["id"],
    )
    return jsonify(dict(negocio_service.obter(conn, g.empresa_id, negocio_id))), 201


@bp.put("/<int:negocio_id>/estagio")
@requires_auth
def mover(negocio_id):
    usuario = g.usuario_atual
    conn = get_db()
    negocio = negocio_service.obter(conn, g.empresa_id, negocio_id)
    if not _pode_mexer(usuario, negocio):
        raise ApiError("Só o responsável por este negócio (ou um administrador) pode movê-lo.", status=403, codigo="sem_permissao")
    dados = request.get_json(silent=True) or {}
    novo_estagio = dados.get("estagio")
    if not novo_estagio:
        raise ApiError("Informe o novo estágio.", status=400)
    valor = dados.get("valor")
    if valor not in (None, ""):
        try:
            valor = float(valor)
        except (TypeError, ValueError):
            raise ApiError("Valor inválido.", status=400)
    else:
        valor = None
    negocio_service.mover_estagio(conn, negocio_id, novo_estagio, valor=valor, motivo_perda=(dados.get("motivo_perda") or "").strip() or None)
    return jsonify(dict(negocio_service.obter(conn, g.empresa_id, negocio_id)))


@bp.put("/<int:negocio_id>")
@requires_auth
def atualizar(negocio_id):
    usuario = g.usuario_atual
    conn = get_db()
    negocio = negocio_service.obter(conn, g.empresa_id, negocio_id)
    if not _pode_mexer(usuario, negocio):
        raise ApiError("Só o responsável por este negócio (ou um administrador) pode editá-lo.", status=403, codigo="sem_permissao")
    dados = request.get_json(silent=True) or {}
    valor = dados.get("valor")
    if valor not in (None, ""):
        try:
            valor = float(valor)
        except (TypeError, ValueError):
            raise ApiError("Valor inválido.", status=400)
    else:
        valor = None
    negocio_service.atualizar(
        conn, g.empresa_id, negocio_id,
        titulo=(dados.get("titulo") or "").strip() or None if "titulo" in dados else None,
        valor=valor if "valor" in dados else None,
        responsavel_usuario_id=dados.get("responsavel_usuario_id"),
    )
    return jsonify(dict(negocio_service.obter(conn, g.empresa_id, negocio_id)))


@bp.delete("/<int:negocio_id>")
@requires_auth
def excluir(negocio_id):
    usuario = g.usuario_atual
    conn = get_db()
    negocio = negocio_service.obter(conn, g.empresa_id, negocio_id)
    if not _pode_mexer(usuario, negocio):
        raise ApiError("Só o responsável por este negócio (ou um administrador) pode excluí-lo.", status=403, codigo="sem_permissao")
    negocio_service.excluir(conn, g.empresa_id, negocio_id)
    return jsonify({"ok": True})
