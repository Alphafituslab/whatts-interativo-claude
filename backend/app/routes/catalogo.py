"""
Catálogo interativo / montador de proposta -- pedido do Clayton
(2026-09-04): pegar o portifólio de terceirização e deixar o cliente
escolher item + faixa de quantidade, já vendo o preço, e no final
montar uma proposta bonita e enviar pelo WhatsApp.

Fase 1 (esta): só o cadastro (admin) dos itens e das faixas de preço.
Fica escondido dos usuários comuns -- só admin mexe -- e a FUTURA tela
do cliente (fase 2) só liga de verdade com catalogo_proposta_ativo em
Configuração, desligado por padrão ("não deixar aparecer ainda para os
usuários, eu quero testar").
"""
from flask import Blueprint, g, jsonify, request

from .. import whatsapp_service
from ..context import ApiError, get_db, requires_admin

bp = Blueprint("catalogo", __name__, url_prefix="/api/v1/whatsapp/catalogo")


def _now_iso():
    return whatsapp_service._now_iso()


def _item_publico(conn, item):
    d = dict(item)
    faixas = conn.execute(
        "SELECT id, quantidade_min, quantidade_max, preco FROM whatsapp_catalogo_faixas "
        "WHERE item_id = ? ORDER BY ordem, quantidade_min",
        (item["id"],),
    ).fetchall()
    d["ativo"] = bool(d.get("ativo"))
    d["faixas"] = [dict(f) for f in faixas]
    return d


def _validar_faixas(faixas_brutas):
    """Cada faixa: {quantidade_min, quantidade_max (pode ser vazio =
    sem teto), preco}. Não impõe que sejam exatamente as 5 faixas
    padrão (1-300 / 301-500 / 501-1000 / 1001-2000 / 2001-5000) -- só
    garante que estão em ordem crescente e sem sobreposição, porque
    cada produto pode acabar precisando de faixas um pouco diferentes."""
    faixas = []
    anterior_max = 0
    for f in faixas_brutas or []:
        try:
            qmin = int(f.get("quantidade_min"))
            preco = float(f.get("preco"))
        except (TypeError, ValueError):
            raise ApiError("Faixa com quantidade ou preço inválido.", status=400)
        qmax_bruto = f.get("quantidade_max")
        qmax = int(qmax_bruto) if qmax_bruto not in (None, "") else None
        if qmin <= 0 or preco < 0 or (qmax is not None and qmax < qmin):
            raise ApiError("Faixa com valores inconsistentes.", status=400)
        if qmin <= anterior_max:
            raise ApiError("As faixas de quantidade precisam estar em ordem, sem sobrepor.", status=400)
        anterior_max = qmax if qmax is not None else 10**9
        faixas.append((qmin, qmax, preco))
    if not faixas:
        raise ApiError("Cadastre pelo menos uma faixa de quantidade/preço.", status=400)
    return faixas


@bp.get("")
@requires_admin
def listar():
    conn = get_db()
    incluir_inativos = request.args.get("todos") == "1"
    sql = "SELECT * FROM whatsapp_catalogo_itens WHERE empresa_id = ?"
    if not incluir_inativos:
        sql += " AND ativo = 1"
    sql += " ORDER BY ordem, nome"
    itens = conn.execute(sql, (g.empresa_id,)).fetchall()
    return jsonify([_item_publico(conn, i) for i in itens])


@bp.get("/<int:item_id>")
@requires_admin
def detalhe(item_id):
    conn = get_db()
    item = conn.execute(
        "SELECT * FROM whatsapp_catalogo_itens WHERE id = ? AND empresa_id = ?", (item_id, g.empresa_id)
    ).fetchone()
    if item is None:
        raise ApiError("Item não encontrado.", status=404, codigo="nao_encontrado")
    return jsonify(_item_publico(conn, item))


@bp.post("")
@requires_admin
def criar():
    usuario = g.usuario_atual
    dados = request.get_json(silent=True) or {}
    nome = (dados.get("nome") or "").strip()
    if not nome:
        raise ApiError("Informe o nome do item.", status=400)
    faixas = _validar_faixas(dados.get("faixas"))

    conn = get_db()
    agora = _now_iso()
    cur = conn.execute(
        """INSERT INTO whatsapp_catalogo_itens (empresa_id, nome, forma, linha, descricao, imagem_url, ordem,
                                                  ativo, criado_por, criado_em, atualizado_em)
           VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)""",
        (g.empresa_id, nome, (dados.get("forma") or "").strip() or None, (dados.get("linha") or "").strip() or None,
         (dados.get("descricao") or "").strip() or None, (dados.get("imagem_url") or "").strip() or None,
         int(dados.get("ordem") or 0), usuario["id"], agora, agora),
    )
    item_id = cur.lastrowid
    for i, (qmin, qmax, preco) in enumerate(faixas):
        conn.execute(
            "INSERT INTO whatsapp_catalogo_faixas (item_id, quantidade_min, quantidade_max, preco, ordem) VALUES (?, ?, ?, ?, ?)",
            (item_id, qmin, qmax, preco, i),
        )
    conn.commit()
    item = conn.execute("SELECT * FROM whatsapp_catalogo_itens WHERE id = ?", (item_id,)).fetchone()
    return jsonify(_item_publico(conn, item)), 201


@bp.put("/<int:item_id>")
@requires_admin
def editar(item_id):
    conn = get_db()
    item = conn.execute(
        "SELECT * FROM whatsapp_catalogo_itens WHERE id = ? AND empresa_id = ?", (item_id, g.empresa_id)
    ).fetchone()
    if item is None:
        raise ApiError("Item não encontrado.", status=404, codigo="nao_encontrado")

    dados = request.get_json(silent=True) or {}
    nome = (dados.get("nome") or "").strip() or item["nome"]
    faixas = _validar_faixas(dados.get("faixas")) if "faixas" in dados else None

    conn.execute(
        """UPDATE whatsapp_catalogo_itens SET nome = ?, forma = ?, linha = ?, descricao = ?, imagem_url = ?,
               ordem = ?, ativo = ?, atualizado_em = ? WHERE id = ?""",
        (nome, (dados.get("forma") or "").strip() or None, (dados.get("linha") or "").strip() or None,
         (dados.get("descricao") or "").strip() or None,
         (dados.get("imagem_url") if "imagem_url" in dados else item["imagem_url"]) or None,
         int(dados["ordem"]) if dados.get("ordem") not in (None, "") else item["ordem"],
         1 if dados.get("ativo", bool(item["ativo"])) else 0,
         _now_iso(), item_id),
    )
    if faixas is not None:
        conn.execute("DELETE FROM whatsapp_catalogo_faixas WHERE item_id = ?", (item_id,))
        for i, (qmin, qmax, preco) in enumerate(faixas):
            conn.execute(
                "INSERT INTO whatsapp_catalogo_faixas (item_id, quantidade_min, quantidade_max, preco, ordem) VALUES (?, ?, ?, ?, ?)",
                (item_id, qmin, qmax, preco, i),
            )
    conn.commit()
    item = conn.execute("SELECT * FROM whatsapp_catalogo_itens WHERE id = ?", (item_id,)).fetchone()
    return jsonify(_item_publico(conn, item))


@bp.delete("/<int:item_id>")
@requires_admin
def excluir(item_id):
    """Não apaga de verdade -- só desativa (ativo=0), mesmo raciocínio
    de contato/tag: some da lista principal mas não quebra nada que já
    referencia esse item (ex.: proposta antiga já enviada, quando essa
    parte existir)."""
    conn = get_db()
    item = conn.execute(
        "SELECT id FROM whatsapp_catalogo_itens WHERE id = ? AND empresa_id = ?", (item_id, g.empresa_id)
    ).fetchone()
    if item is None:
        raise ApiError("Item não encontrado.", status=404, codigo="nao_encontrado")
    conn.execute(
        "UPDATE whatsapp_catalogo_itens SET ativo = 0, atualizado_em = ? WHERE id = ?", (_now_iso(), item_id)
    )
    conn.commit()
    return jsonify({"ok": True})
