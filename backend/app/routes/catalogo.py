"""
Catálogo interativo / montador de proposta -- pedido do Clayton
(2026-09-04): pegar o portifólio de terceirização e deixar o cliente
escolher item + faixa de quantidade, já vendo o preço, e no final
montar uma proposta bonita e enviar pelo WhatsApp.

Fase 1 (esta): só o cadastro (admin) dos itens, faixas de preço,
galeria de imagens e a informação nutricional (porção, tabela de
nutrientes, ingredientes, modo de uso -- copiado do modelo de
portifólio que o Clayton mandou). Fica escondido dos usuários comuns --
só admin mexe -- e a FUTURA tela do cliente (fase 2) só liga de
verdade com catalogo_proposta_ativo em Configuração, desligado por
padrão ("não deixar aparecer ainda para os usuários, eu quero testar").

Layout consistente conforme o Clayton vai cadastrando mais fórmulas:
o cadastro é só DADOS (nome, tabela nutricional, faixas, galeria...);
quem desenha o cartão do produto é sempre o MESMO template (no
frontend), nunca um layout novo por item -- é assim que garante "tudo
igual" sem precisar redesenhar nada a cada produto novo.
"""
from flask import Blueprint, g, jsonify, request

from .. import whatsapp_service
from ..context import ApiError, get_db, requires_admin
from .whatsapp import _classificar_tipo

bp = Blueprint("catalogo", __name__, url_prefix="/api/v1/whatsapp/catalogo")

# Ícone/cor padrão por categoria -- só entra em ação quando ninguém
# personalizou ainda (ver whatsapp_catalogo_categorias). Pedido do
# Clayton (2026-09-08): menu de categorias no catálogo público, com
# ícone "que dá pra mudar depois". Casamento por palavra-chave (não por
# nome exato) porque a categoria é texto livre no cadastro -- ex.: o
# Clayton já cadastrou "imunidade" em minúsculo, sem o prefixo "Linha".
_ICONES_POR_PALAVRA = [
    (("imunidade",), "🛡️"),
    (("peso", "emagre"), "⚖️"),
    (("beauty", "beleza"), "✨"),
    (("sono",), "🌙"),
    (("cogni",), "🧠"),
    (("osso", "articula"), "🦴"),
    (("isolado",), "🧬"),
    (("polivitam", "mineral", "vitamin"), "💊"),
    (("fitness", "muscul", "hipertrofia"), "🏋️"),
]
_CORES_PADRAO = ["#1fa855", "#e08a2b", "#d3567c", "#5b6fd1", "#8552c9", "#4a7a92", "#0f9e7a", "#9aa832", "#c65b3a"]


def _icone_padrao(nome):
    baixo = (nome or "").lower()
    for palavras, icone in _ICONES_POR_PALAVRA:
        if any(p in baixo for p in palavras):
            return icone
    return "📦"


def _cor_padrao(nome):
    indice = sum(ord(c) for c in (nome or "")) % len(_CORES_PADRAO)
    return _CORES_PADRAO[indice]


def categorias_publicas(conn, empresa_id, nomes):
    """Lista de categorias (nome + ícone + cor), na ordem recebida em
    `nomes` -- usada tanto pelo cadastro (admin) quanto pela página
    pública do cliente, pra sempre bater o mesmo ícone/cor nos dois
    lugares."""
    if not nomes:
        return []
    marcadores = ",".join("?" for _ in nomes)
    salvas = {
        r["nome"]: r for r in conn.execute(
            f"SELECT nome, icone, cor FROM whatsapp_catalogo_categorias WHERE empresa_id = ? AND nome IN ({marcadores})",
            (empresa_id, *nomes),
        ).fetchall()
    }
    resultado = []
    for nome in nomes:
        s = salvas.get(nome)
        resultado.append({
            "nome": nome,
            "icone": (s["icone"] if s and s["icone"] else _icone_padrao(nome)),
            "cor": (s["cor"] if s and s["cor"] else _cor_padrao(nome)),
        })
    return resultado

# Linhas do portifólio modelo -- só uma sugestão pro campo (não trava:
# o cadastro aceita texto livre também, caso surja uma linha nova).
LINHAS_SUGERIDAS = [
    "Linha Fitness", "Linha Emagrecimento", "Linha Beauty",
    "Linha Polivitamínicos e Minerais", "Linha Sono", "Linha Cognição",
    "Linha Ossos e Articulações", "Linha Isolados",
]


def _now_iso():
    return whatsapp_service._now_iso()


def _item_publico(conn, item):
    d = dict(item)
    faixas = conn.execute(
        "SELECT id, quantidade_min, quantidade_max, preco FROM whatsapp_catalogo_faixas "
        "WHERE item_id = ? ORDER BY ordem, quantidade_min",
        (item["id"],),
    ).fetchall()
    nutrientes = conn.execute(
        "SELECT id, nome, quantidade, vd FROM whatsapp_catalogo_nutrientes "
        "WHERE item_id = ? ORDER BY ordem, id",
        (item["id"],),
    ).fetchall()
    imagens = conn.execute(
        "SELECT id, url, tipo FROM whatsapp_catalogo_imagens WHERE item_id = ? ORDER BY ordem, id",
        (item["id"],),
    ).fetchall()
    d["ativo"] = bool(d.get("ativo"))
    d["faixas"] = [dict(f) for f in faixas]
    d["nutrientes"] = [dict(n) for n in nutrientes]
    d["imagens"] = [dict(im) for im in imagens]
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


def _validar_nutrientes(nutrientes_brutos):
    """Cada linha da tabela de informação nutricional: {nome,
    quantidade, vd}. Livre de propósito (sem lista fixa de nutrientes)
    -- cada suplemento do portifólio tem um conjunto bem diferente de
    linhas (creatina pura é 1 linha; um polivitamínico é uma dúzia)."""
    nutrientes = []
    for n in nutrientes_brutos or []:
        nome = (n.get("nome") or "").strip()
        if not nome:
            continue
        nutrientes.append((nome, (n.get("quantidade") or "").strip() or None, (n.get("vd") or "").strip() or None))
    return nutrientes


def _validar_imagens(imagens_brutas):
    """Lista de URLs (string) -- cada produto pode ter de 1 a N fotos.
    Ignora entradas vazias."""
    return [u.strip() for u in (imagens_brutas or []) if isinstance(u, str) and u.strip()]


def _salvar_nutrientes(conn, item_id, nutrientes):
    conn.execute("DELETE FROM whatsapp_catalogo_nutrientes WHERE item_id = ?", (item_id,))
    for i, (nome, quantidade, vd) in enumerate(nutrientes):
        conn.execute(
            "INSERT INTO whatsapp_catalogo_nutrientes (item_id, nome, quantidade, vd, ordem) VALUES (?, ?, ?, ?, ?)",
            (item_id, nome, quantidade, vd, i),
        )


def _salvar_imagens(conn, item_id, imagens):
    conn.execute("DELETE FROM whatsapp_catalogo_imagens WHERE item_id = ?", (item_id,))
    for i, url in enumerate(imagens):
        # Vídeo ou imagem, decidido pela extensão do arquivo -- pedido
        # do Clayton: "se for um vídeo deixar também" na galeria.
        tipo = "video" if _classificar_tipo(url) == "video" else "imagem"
        conn.execute(
            "INSERT INTO whatsapp_catalogo_imagens (item_id, url, tipo, ordem) VALUES (?, ?, ?, ?)",
            (item_id, url, tipo, i),
        )


@bp.get("/linhas-sugeridas")
@requires_admin
def linhas_sugeridas():
    return jsonify(LINHAS_SUGERIDAS)


@bp.get("/categorias")
@requires_admin
def listar_categorias():
    conn = get_db()
    linhas = conn.execute(
        "SELECT DISTINCT linha FROM whatsapp_catalogo_itens "
        "WHERE empresa_id = ? AND ativo = 1 AND linha IS NOT NULL AND linha != '' ORDER BY linha",
        (g.empresa_id,),
    ).fetchall()
    return jsonify(categorias_publicas(conn, g.empresa_id, [l["linha"] for l in linhas]))


@bp.put("/categorias")
@requires_admin
def salvar_categoria():
    dados = request.get_json(silent=True) or {}
    nome = (dados.get("nome") or "").strip()
    if not nome:
        raise ApiError("Categoria inválida.", status=400)
    icone = (dados.get("icone") or "").strip() or None
    cor = (dados.get("cor") or "").strip() or None
    conn = get_db()
    conn.execute(
        "INSERT INTO whatsapp_catalogo_categorias (empresa_id, nome, icone, cor, criado_em) VALUES (?, ?, ?, ?, ?) "
        "ON CONFLICT(empresa_id, nome) DO UPDATE SET icone = excluded.icone, cor = excluded.cor",
        (g.empresa_id, nome, icone, cor, _now_iso()),
    )
    conn.commit()
    return jsonify({"ok": True})


@bp.get("/propostas")
@requires_admin
def listar_propostas():
    """Propostas que clientes já preencheram e mandaram de volta pelo
    link público -- pedido do Clayton (2026-09-07): "quando o cliente
    preenche, devolve com as fórmulas escolhidas?" (devolve, só que até
    aqui só aparecia dentro da conversa do WhatsApp; isso aqui é a
    telinha de relatório que faltava)."""
    conn = get_db()
    condicoes = ["p.empresa_id = ?"]
    params = [g.empresa_id]

    de = (request.args.get("de") or "").strip()
    if de:
        condicoes.append("p.criado_em >= ?")
        params.append(de + "T00:00:00.000Z")
    ate = (request.args.get("ate") or "").strip()
    if ate:
        condicoes.append("p.criado_em <= ?")
        params.append(ate + "T23:59:59.999Z")
    busca = (request.args.get("busca") or "").strip()
    if busca:
        condicoes.append("(ct.nome LIKE ? OR ct.telefone LIKE ?)")
        params.extend([f"%{busca}%", f"%{busca}%"])

    sql = f"""
        SELECT p.id, p.criado_em, p.total, p.conversa_id,
               ct.nome AS cliente_nome, ct.telefone AS cliente_telefone,
               u.nome AS enviado_por_nome
        FROM whatsapp_catalogo_propostas p
        JOIN whatsapp_catalogo_links l ON l.id = p.link_id
        JOIN whatsapp_conversas c ON c.id = p.conversa_id
        JOIN whatsapp_contatos ct ON ct.id = c.contato_id
        LEFT JOIN usuarios u ON u.id = l.criado_por
        WHERE {" AND ".join(condicoes)}
        ORDER BY p.criado_em DESC
        LIMIT 300
    """
    propostas = conn.execute(sql, params).fetchall()
    if not propostas:
        return jsonify([])

    ids = [p["id"] for p in propostas]
    marcadores = ",".join("?" for _ in ids)
    itens = conn.execute(
        f"SELECT proposta_id, nome_item, quantidade, preco_unitario, subtotal "
        f"FROM whatsapp_catalogo_propostas_itens WHERE proposta_id IN ({marcadores}) ORDER BY id",
        ids,
    ).fetchall()
    itens_por_proposta = {}
    for it in itens:
        itens_por_proposta.setdefault(it["proposta_id"], []).append(dict(it))

    return jsonify([
        {
            "id": p["id"],
            "criado_em": p["criado_em"],
            "total": p["total"],
            "conversa_id": p["conversa_id"],
            "cliente_nome": p["cliente_nome"],
            "cliente_telefone": p["cliente_telefone"],
            "enviado_por_nome": p["enviado_por_nome"],
            "itens": itens_por_proposta.get(p["id"], []),
        }
        for p in propostas
    ])


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
    nutrientes = _validar_nutrientes(dados.get("nutrientes"))
    imagens = _validar_imagens(dados.get("imagens"))

    conn = get_db()
    agora = _now_iso()
    cur = conn.execute(
        """INSERT INTO whatsapp_catalogo_itens (empresa_id, nome, forma, linha, descricao, imagem_url, ordem,
                                                  sabor, porcao, ingredientes, modo_de_uso, observacao_nutricional,
                                                  complemento, ativo, criado_por, criado_em, atualizado_em)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)""",
        (g.empresa_id, nome, (dados.get("forma") or "").strip() or None, (dados.get("linha") or "").strip() or None,
         (dados.get("descricao") or "").strip() or None, imagens[0] if imagens else None,
         int(dados.get("ordem") or 0),
         (dados.get("sabor") or "").strip() or None, (dados.get("porcao") or "").strip() or None,
         (dados.get("ingredientes") or "").strip() or None, (dados.get("modo_de_uso") or "").strip() or None,
         (dados.get("observacao_nutricional") or "").strip() or None,
         (dados.get("complemento") or "").strip() or None,
         usuario["id"], agora, agora),
    )
    item_id = cur.lastrowid
    for i, (qmin, qmax, preco) in enumerate(faixas):
        conn.execute(
            "INSERT INTO whatsapp_catalogo_faixas (item_id, quantidade_min, quantidade_max, preco, ordem) VALUES (?, ?, ?, ?, ?)",
            (item_id, qmin, qmax, preco, i),
        )
    _salvar_nutrientes(conn, item_id, nutrientes)
    _salvar_imagens(conn, item_id, imagens)
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
    nutrientes = _validar_nutrientes(dados.get("nutrientes")) if "nutrientes" in dados else None
    imagens = _validar_imagens(dados.get("imagens")) if "imagens" in dados else None

    def _campo(chave):
        return (dados.get(chave) or "").strip() or None if chave in dados else item[chave]

    imagem_url = (imagens[0] if imagens else None) if imagens is not None else item["imagem_url"]
    conn.execute(
        """UPDATE whatsapp_catalogo_itens SET nome = ?, forma = ?, linha = ?, descricao = ?, imagem_url = ?,
               ordem = ?, sabor = ?, porcao = ?, ingredientes = ?, modo_de_uso = ?, observacao_nutricional = ?,
               complemento = ?, ativo = ?, atualizado_em = ? WHERE id = ?""",
        (nome, _campo("forma"), _campo("linha"), _campo("descricao"), imagem_url,
         int(dados["ordem"]) if dados.get("ordem") not in (None, "") else item["ordem"],
         _campo("sabor"), _campo("porcao"), _campo("ingredientes"), _campo("modo_de_uso"),
         _campo("observacao_nutricional"), _campo("complemento"),
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
    if nutrientes is not None:
        _salvar_nutrientes(conn, item_id, nutrientes)
    if imagens is not None:
        _salvar_imagens(conn, item_id, imagens)
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
