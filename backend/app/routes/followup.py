"""
Follow-up — acompanhamento pra nenhum cliente ficar esquecido.

Visibilidade segue a mesma régua do resto do sistema: cada um vê o que é
dele (ou da fila do seu setor); admin vê tudo.
"""
import datetime

from flask import Blueprint, g, jsonify, request

from .. import followup_service, whatsapp_service
from ..context import ApiError, get_db, requires_admin, requires_auth

bp = Blueprint("followup", __name__, url_prefix="/api/v1/followup")


def _escopo():
    """Admin enxerga a empresa toda; os demais, só o que é deles — o que
    está atribuído a eles mais a fila de TODOS os setores que atendem."""
    usuario = g.usuario_atual
    if usuario["admin"]:
        return None, None
    return usuario["id"], whatsapp_service.setores_do_usuario(get_db(), usuario["id"])


def _carregar_conversa(conn, conversa_id):
    conversa = conn.execute(
        "SELECT c.*, ct.telefone FROM whatsapp_conversas c JOIN whatsapp_contatos ct ON ct.id = c.contato_id "
        "WHERE c.id = ? AND ct.empresa_id = ?",
        (conversa_id, g.empresa_id),
    ).fetchone()
    if conversa is None:
        raise ApiError("Conversa não encontrada.", status=404, codigo="nao_encontrado")
    return conversa


@bp.get("/resumo")
@requires_auth
def resumo():
    """Números do sino — chamado com frequência, então é só contagem."""
    usuario_id, setores = _escopo()
    return jsonify(followup_service.resumo(get_db(), g.empresa_id, usuario_id, setores))


@bp.get("")
@requires_auth
def listar():
    usuario_id, setores = _escopo()
    apenas_pendentes = request.args.get("pendentes") == "1"
    itens = followup_service.listar(get_db(), g.empresa_id, usuario_id, setores, apenas_pendentes)
    situacao = request.args.get("situacao")
    if situacao:
        itens = [i for i in itens if i["situacao"] == situacao]
    return jsonify(itens)


@bp.put("/conversas/<int:conversa_id>/agendar")
@requires_auth
def agendar(conversa_id):
    """Marca o próximo contato. Enquanto a data não chegar, esta conversa
    para de gerar alerta de abandono (regra 15)."""
    conn = get_db()
    _carregar_conversa(conn, conversa_id)
    dados = request.get_json(silent=True) or {}
    quando = (dados.get("quando") or "").strip()
    if not quando:
        raise ApiError("Informe a data e o horário do próximo contato.", status=400)
    forma = (dados.get("forma") or "whatsapp").strip()
    if forma not in followup_service.FORMAS_CONTATO:
        raise ApiError("Forma de contato inválida.", status=400)
    obs = (dados.get("observacao") or "").strip() or None

    conn.execute(
        """UPDATE whatsapp_conversas
           SET proximo_contato_em = ?, proximo_contato_forma = ?, proximo_contato_obs = ?,
               followup_adiado_ate = NULL, etapa = 'agendado'
           WHERE id = ?""",
        (quando, forma, obs, conversa_id),
    )
    followup_service.registrar_historico(
        conn, conversa_id, g.usuario_atual["id"], "agendado", f"{quando} por {forma}" + (f" — {obs}" if obs else "")
    )
    return jsonify({"ok": True})


@bp.post("/conversas/<int:conversa_id>/adiar")
@requires_auth
def adiar(conversa_id):
    """Silencia o alerta por um tempo, sem virar compromisso com o
    cliente (diferente de agendar)."""
    conn = get_db()
    _carregar_conversa(conn, conversa_id)
    dados = request.get_json(silent=True) or {}
    atalhos = {"1h": 1 / 24, "amanha": 1, "2dias": 2, "3dias": 3, "7dias": 7}
    if dados.get("ate"):
        ate = dados["ate"]
    else:
        dias = atalhos.get(dados.get("quanto"))
        if dias is None:
            raise ApiError("Informe por quanto tempo adiar.", status=400)
        ate = (datetime.datetime.utcnow() + datetime.timedelta(days=dias)).strftime("%Y-%m-%dT%H:%M:%S.%fZ")
    conn.execute("UPDATE whatsapp_conversas SET followup_adiado_ate = ? WHERE id = ?", (ate, conversa_id))
    followup_service.registrar_historico(conn, conversa_id, g.usuario_atual["id"], "adiado", f"até {ate}")
    return jsonify({"ok": True, "ate": ate})


@bp.put("/conversas/<int:conversa_id>/etapa")
@requires_auth
def mudar_etapa(conversa_id):
    conn = get_db()
    _carregar_conversa(conn, conversa_id)
    dados = request.get_json(silent=True) or {}
    etapa = (dados.get("etapa") or "").strip()
    if etapa not in followup_service.ETAPAS_VALIDAS:
        raise ApiError("Etapa inválida.", status=400)
    prioridade = (dados.get("prioridade") or "").strip()
    if prioridade and prioridade not in followup_service.PRIORIDADES_VALIDAS:
        raise ApiError("Prioridade inválida.", status=400)

    if prioridade:
        conn.execute("UPDATE whatsapp_conversas SET etapa = ?, prioridade = ? WHERE id = ?", (etapa, prioridade, conversa_id))
    else:
        conn.execute("UPDATE whatsapp_conversas SET etapa = ? WHERE id = ?", (etapa, conversa_id))
    followup_service.registrar_historico(
        conn, conversa_id, g.usuario_atual["id"], "etapa", etapa + (f" / prioridade {prioridade}" if prioridade else "")
    )
    return jsonify({"ok": True})


@bp.get("/conversas/<int:conversa_id>/historico")
@requires_auth
def historico(conversa_id):
    conn = get_db()
    _carregar_conversa(conn, conversa_id)
    rows = conn.execute(
        """SELECT h.acao, h.detalhe, h.criado_em, u.nome AS usuario_nome
           FROM whatsapp_followup_historico h
           LEFT JOIN usuarios u ON u.id = h.usuario_id
           WHERE h.conversa_id = ? ORDER BY h.criado_em DESC, h.id DESC LIMIT 100""",
        (conversa_id,),
    ).fetchall()
    return jsonify([dict(r) for r in rows])


@bp.get("/opcoes")
@requires_auth
def opcoes():
    """Etapas, prioridades e formas de contato — pro frontend montar os
    menus sem repetir a lista dele mesmo."""
    return jsonify({
        "etapas": [{"valor": v, "rotulo": r} for v, r in followup_service.ETAPAS],
        "prioridades": [{"valor": v, "rotulo": r} for v, r in followup_service.PRIORIDADES],
        "formas": followup_service.FORMAS_CONTATO,
    })


# ============================================================
# Configuração de prazos (admin)
# ============================================================
@bp.get("/prazos")
@requires_admin
def listar_prazos():
    conn = get_db()
    padrao, _ = followup_service.obter_prazos(conn, g.empresa_id)
    rows = conn.execute(
        "SELECT id, criterio, valor, dias FROM whatsapp_followup_prazos WHERE empresa_id = ? ORDER BY criterio, valor",
        (g.empresa_id,),
    ).fetchall()
    return jsonify({"padrao_dias": padrao, "excecoes": [dict(r) for r in rows]})


@bp.put("/prazos/padrao")
@requires_admin
def definir_prazo_padrao():
    dados = request.get_json(silent=True) or {}
    try:
        dias = int(dados.get("dias"))
    except (TypeError, ValueError):
        raise ApiError("Informe um número de dias.", status=400)
    if not 1 <= dias <= 365:
        raise ApiError("O prazo deve ficar entre 1 e 365 dias.", status=400)
    get_db().execute("UPDATE configuracoes_whatsapp SET followup_dias = ? WHERE empresa_id = ?", (dias, g.empresa_id))
    return jsonify({"ok": True})


@bp.post("/prazos")
@requires_admin
def criar_prazo():
    dados = request.get_json(silent=True) or {}
    criterio = (dados.get("criterio") or "").strip()
    valor = (dados.get("valor") or "").strip()
    if criterio not in ("setor", "prioridade", "etapa") or not valor:
        raise ApiError("Informe o critério (setor, prioridade ou etapa) e o valor.", status=400)
    try:
        dias = int(dados.get("dias"))
    except (TypeError, ValueError):
        raise ApiError("Informe um número de dias.", status=400)
    if not 1 <= dias <= 365:
        raise ApiError("O prazo deve ficar entre 1 e 365 dias.", status=400)

    conn = get_db()
    ja = conn.execute(
        "SELECT id FROM whatsapp_followup_prazos WHERE empresa_id = ? AND criterio = ? AND valor = ?",
        (g.empresa_id, criterio, valor),
    ).fetchone()
    if ja:
        conn.execute("UPDATE whatsapp_followup_prazos SET dias = ? WHERE id = ?", (dias, ja["id"]))
        return jsonify({"ok": True, "id": ja["id"]})
    cur = conn.execute(
        "INSERT INTO whatsapp_followup_prazos (empresa_id, criterio, valor, dias, criado_em) VALUES (?, ?, ?, ?, ?)",
        (g.empresa_id, criterio, valor, dias, whatsapp_service._now_iso()),
    )
    return jsonify({"ok": True, "id": cur.lastrowid}), 201


@bp.delete("/prazos/<int:prazo_id>")
@requires_admin
def excluir_prazo(prazo_id):
    cur = get_db().execute(
        "DELETE FROM whatsapp_followup_prazos WHERE id = ? AND empresa_id = ?", (prazo_id, g.empresa_id)
    )
    if cur.rowcount == 0:
        raise ApiError("Prazo não encontrado.", status=404, codigo="nao_encontrado")
    return jsonify({"ok": True})
