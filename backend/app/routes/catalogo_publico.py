"""
Catálogo/Proposta -- Fase 2: o link que o cliente recebe no WhatsApp.

SEM autenticação de propósito -- é a página que o cliente (que não tem
conta no sistema) abre pra escolher os itens. A segurança vem do token
aleatório (mesma ideia do webhook_segredo), não de login.

O fluxo: alguém do time clica "Enviar catálogo" numa conversa (rota
autenticada em routes/whatsapp.py) -> gera um link com token -> manda
esse link pro cliente como mensagem normal de WhatsApp. O cliente abre,
escolhe item + quantidade (o preço da faixa certa aparece na hora, MAS
o preço final é sempre recalculado aqui no servidor -- nunca confia no
que o navegador do cliente manda), confirma, e a proposta pronta é
enviada de volta pra conversa dele automaticamente.
"""
import json
import secrets

from flask import Blueprint, jsonify, request

from .. import whatsapp_service
from ..context import ApiError, get_db

bp = Blueprint("catalogo_publico", __name__, url_prefix="/api/v1/catalogo-publico")

DIAS_VALIDADE_LINK = 30


def _now_iso():
    return whatsapp_service._now_iso()


def _carregar_link(conn, token):
    link = conn.execute("SELECT * FROM whatsapp_catalogo_links WHERE token = ?", (token,)).fetchone()
    if link is None:
        raise ApiError("Link não encontrado.", status=404, codigo="nao_encontrado")
    expirado = conn.execute("SELECT datetime('now') > datetime(?)", (link["expira_em"],)).fetchone()[0]
    if expirado:
        raise ApiError("Este link expirou. Peça um novo.", status=410, codigo="link_expirado")
    return link


def _preco_da_faixa(conn, item_id, quantidade):
    faixa = conn.execute(
        "SELECT preco FROM whatsapp_catalogo_faixas WHERE item_id = ? AND quantidade_min <= ? "
        "AND (quantidade_max IS NULL OR quantidade_max >= ?) ORDER BY quantidade_min DESC LIMIT 1",
        (item_id, quantidade, quantidade),
    ).fetchone()
    return faixa["preco"] if faixa else None


@bp.get("/<token>")
def ver_catalogo(token):
    conn = get_db()
    link = _carregar_link(conn, token)
    itens = conn.execute(
        "SELECT * FROM whatsapp_catalogo_itens WHERE empresa_id = ? AND ativo = 1 ORDER BY ordem, nome",
        (link["empresa_id"],),
    ).fetchall()
    itens_publicos = []
    for item in itens:
        d = dict(item)
        faixas = conn.execute(
            "SELECT quantidade_min, quantidade_max, preco FROM whatsapp_catalogo_faixas "
            "WHERE item_id = ? ORDER BY ordem, quantidade_min", (item["id"],),
        ).fetchall()
        nutrientes = conn.execute(
            "SELECT nome, quantidade, vd FROM whatsapp_catalogo_nutrientes "
            "WHERE item_id = ? ORDER BY ordem, id", (item["id"],),
        ).fetchall()
        d["faixas"] = [dict(f) for f in faixas]
        d["nutrientes"] = [dict(n) for n in nutrientes]
        # Caminho relativo mesmo (ex.: "/api/v1/whatsapp/uploads/x.png") --
        # o navegador do cliente resolve sozinho contra o domínio público
        # desta própria página. url_publica() é pra outra coisa (URL que
        # a Evolution API, rodando num container à parte, precisa
        # alcançar por dentro da rede Docker -- não serve pro navegador).
        d["imagem_url"] = item["imagem_url"] or None
        itens_publicos.append(d)

    conversa = conn.execute(
        "SELECT ct.nome AS contato_nome FROM whatsapp_conversas c "
        "JOIN whatsapp_contatos ct ON ct.id = c.contato_id WHERE c.id = ?", (link["conversa_id"],),
    ).fetchone()
    config = conn.execute(
        "SELECT logo_url FROM configuracoes_whatsapp WHERE empresa_id = ?", (link["empresa_id"],)
    ).fetchone()
    return jsonify({
        "itens": itens_publicos,
        "contato_nome": conversa["contato_nome"] if conversa else None,
        "logo_url": (config["logo_url"] if config and config["logo_url"] else None),
    })


@bp.post("/<token>/proposta")
def enviar_proposta(token):
    conn = get_db()
    link = _carregar_link(conn, token)
    dados = request.get_json(silent=True) or {}
    escolhas = dados.get("itens") or []
    if not escolhas:
        raise ApiError("Escolha pelo menos um item.", status=400)

    linhas_proposta = []
    total = 0.0
    for escolha in escolhas:
        try:
            item_id = int(escolha.get("item_id"))
            quantidade = int(escolha.get("quantidade"))
        except (TypeError, ValueError):
            raise ApiError("Item ou quantidade inválidos.", status=400)
        if quantidade <= 0:
            continue
        item = conn.execute(
            "SELECT id, nome FROM whatsapp_catalogo_itens WHERE id = ? AND empresa_id = ? AND ativo = 1",
            (item_id, link["empresa_id"]),
        ).fetchone()
        if item is None:
            continue  # item pode ter sido desativado entre o cliente abrir a pagina e confirmar
        # Preço sempre recalculado aqui -- nunca confia no que o navegador do cliente mandou.
        preco = _preco_da_faixa(conn, item_id, quantidade)
        if preco is None:
            raise ApiError(f'Quantidade fora das faixas cadastradas pra "{item["nome"]}".', status=400)
        subtotal = round(preco * quantidade, 2)
        total += subtotal
        linhas_proposta.append((item_id, item["nome"], quantidade, preco, subtotal))

    if not linhas_proposta:
        raise ApiError("Nenhum item válido selecionado.", status=400)
    total = round(total, 2)

    agora = _now_iso()
    cur = conn.execute(
        "INSERT INTO whatsapp_catalogo_propostas (link_id, conversa_id, empresa_id, total, criado_em) VALUES (?, ?, ?, ?, ?)",
        (link["id"], link["conversa_id"], link["empresa_id"], total, agora),
    )
    proposta_id = cur.lastrowid
    for item_id, nome_item, quantidade, preco, subtotal in linhas_proposta:
        conn.execute(
            "INSERT INTO whatsapp_catalogo_propostas_itens (proposta_id, item_id, nome_item, quantidade, preco_unitario, subtotal) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (proposta_id, item_id, nome_item, quantidade, preco, subtotal),
        )
    conn.execute("UPDATE whatsapp_catalogo_links SET usado_em = ? WHERE id = ?", (agora, link["id"]))
    conn.commit()

    # Monta a mensagem e manda de volta pra conversa do cliente -- mesmo
    # caminho de qualquer mensagem de saída (contato -> enviar_texto ->
    # grava em whatsapp_mensagens).
    config = conn.execute("SELECT * FROM configuracoes_whatsapp WHERE empresa_id = ?", (link["empresa_id"],)).fetchone()
    conversa = conn.execute(
        "SELECT c.id, ct.telefone FROM whatsapp_conversas c JOIN whatsapp_contatos ct ON ct.id = c.contato_id WHERE c.id = ?",
        (link["conversa_id"],),
    ).fetchone()
    def _brl(v):
        return f"{v:,.2f}".replace(",", "_").replace(".", ",").replace("_", ".")

    linhas_texto = "\n".join(
        f"• {nome} — {qtd} un. × R$ {_brl(preco)} = *R$ {_brl(subtotal)}*"
        for _, nome, qtd, preco, subtotal in linhas_proposta
    )
    texto = (
        "🗂️ *Proposta Alphafitus*\n\n"
        f"{linhas_texto}\n\n"
        f"*Total: R$ {_brl(total)}*\n\n"
        "Em breve alguém da nossa equipe entra em contato pra fechar os detalhes. Obrigado! 🙌"
    )
    if config and conversa:
        try:
            externo_id = whatsapp_service.enviar_texto(dict(config), conversa["telefone"], texto)
        except Exception:
            externo_id = None
        conn.execute(
            "INSERT INTO whatsapp_mensagens (conversa_id, direcao, tipo, texto, externo_id, status, criado_em) "
            "VALUES (?, 'saida', 'texto', ?, ?, 'enviada', ?)",
            (conversa["id"], texto, externo_id, agora),
        )
        conn.execute(
            "UPDATE whatsapp_conversas SET ultima_mensagem_em = ?, ultima_mensagem_preview = ? WHERE id = ?",
            (agora, texto[:120], conversa["id"]),
        )
        conn.commit()

    return jsonify({"ok": True, "total": total}), 201
