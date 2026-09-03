"""
Planilha de Ligações -- pedido do Clayton (2026-09-03): uma tela pra
controlar as ligações de prospecção (dia, empresa, com quem falou, pra
quem terceirizam, quem é o responsável pela área de suplementos/novos
produtos/contratação de fabricantes), editável direto no sistema, com
histórico completo e exportação em Excel/PDF.

Compartilhada pela empresa toda (mesmo padrão de respostas prontas e
etiquetas) -- qualquer um com acesso às conversas pode ver e editar.
"""
import datetime
import io

from flask import Blueprint, g, jsonify, request, send_file

from ..context import ApiError, get_db, requires_auth

bp = Blueprint("ligacoes", __name__, url_prefix="/api/v1/ligacoes")

CAMPOS_EDITAVEIS = (
    "data_ligacao", "empresa_contatada", "contato_nome",
    "terceiriza_para", "responsavel_area", "observacoes",
)

COLUNAS = (
    ("data_ligacao", "Data"),
    ("empresa_contatada", "Empresa"),
    ("contato_nome", "Com quem falei"),
    ("terceiriza_para", "Terceirizam para"),
    ("responsavel_area", "Responsável (suplementos/novos produtos/fabricantes)"),
    ("observacoes", "Observações"),
)


def _now_iso():
    return datetime.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def _carregar(conn, empresa_id, ligacao_id):
    row = conn.execute(
        "SELECT * FROM crm_ligacoes WHERE id = ? AND empresa_id = ?", (ligacao_id, empresa_id)
    ).fetchone()
    if row is None:
        raise ApiError("Ligação não encontrada.", status=404, codigo="nao_encontrado")
    return row


@bp.get("")
@requires_auth
def listar():
    conn = get_db()
    rows = conn.execute(
        "SELECT l.*, u.nome AS criado_por_nome FROM crm_ligacoes l "
        "LEFT JOIN usuarios u ON u.id = l.criado_por "
        "WHERE l.empresa_id = ? ORDER BY l.ordem, l.id",
        (g.empresa_id,),
    ).fetchall()
    return jsonify([dict(r) for r in rows])


@bp.post("")
@requires_auth
def criar():
    conn = get_db()
    usuario = g.usuario_atual
    agora = _now_iso()
    maior_ordem = conn.execute(
        "SELECT COALESCE(MAX(ordem), -1) AS v FROM crm_ligacoes WHERE empresa_id = ?", (g.empresa_id,)
    ).fetchone()["v"]
    cur = conn.execute(
        "INSERT INTO crm_ligacoes (empresa_id, data_ligacao, ordem, criado_por, criado_em) VALUES (?, ?, ?, ?, ?)",
        (g.empresa_id, datetime.date.today().isoformat(), maior_ordem + 1, usuario["id"], agora),
    )
    conn.commit()
    return jsonify(dict(_carregar(conn, g.empresa_id, cur.lastrowid))), 201


@bp.put("/<int:ligacao_id>")
@requires_auth
def atualizar(ligacao_id):
    conn = get_db()
    _carregar(conn, g.empresa_id, ligacao_id)  # 404 se não for desta empresa
    dados = request.get_json(silent=True) or {}
    campos, valores = [], []
    for campo in CAMPOS_EDITAVEIS:
        if campo in dados:
            valor = dados[campo]
            campos.append(f"{campo} = ?")
            valores.append((valor or "").strip() or None if isinstance(valor, str) else valor)
    if not campos:
        return jsonify({"ok": True})
    campos.append("atualizado_em = ?")
    valores.append(_now_iso())
    campos.append("atualizado_por = ?")
    valores.append(g.usuario_atual["id"])
    valores.extend([ligacao_id, g.empresa_id])
    conn.execute(f"UPDATE crm_ligacoes SET {', '.join(campos)} WHERE id = ? AND empresa_id = ?", valores)
    conn.commit()
    return jsonify(dict(_carregar(conn, g.empresa_id, ligacao_id)))


@bp.delete("/<int:ligacao_id>")
@requires_auth
def excluir(ligacao_id):
    conn = get_db()
    _carregar(conn, g.empresa_id, ligacao_id)
    conn.execute("DELETE FROM crm_ligacoes WHERE id = ? AND empresa_id = ?", (ligacao_id, g.empresa_id))
    conn.commit()
    return jsonify({"ok": True})


def _linhas_ordenadas(conn):
    return conn.execute(
        "SELECT * FROM crm_ligacoes WHERE empresa_id = ? ORDER BY ordem, id", (g.empresa_id,)
    ).fetchall()


@bp.get("/exportar.xlsx")
@requires_auth
def exportar_xlsx():
    from openpyxl import Workbook
    from openpyxl.styles import Font, PatternFill

    conn = get_db()
    linhas = _linhas_ordenadas(conn)

    wb = Workbook()
    ws = wb.active
    ws.title = "Ligações"
    cabecalho = [rotulo for _, rotulo in COLUNAS]
    ws.append(cabecalho)
    for cel in ws[1]:
        cel.font = Font(bold=True, color="FFFFFF")
        cel.fill = PatternFill("solid", fgColor="0A7D67")
    for linha in linhas:
        ws.append([linha[campo] or "" for campo, _ in COLUNAS])
    larguras = [12, 26, 22, 26, 34, 40]
    for i, largura in enumerate(larguras, start=1):
        ws.column_dimensions[ws.cell(row=1, column=i).column_letter].width = largura
    ws.freeze_panes = "A2"

    buffer = io.BytesIO()
    wb.save(buffer)
    buffer.seek(0)
    return send_file(
        buffer, as_attachment=True, download_name="ligacoes.xlsx",
        mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    )


@bp.get("/exportar.pdf")
@requires_auth
def exportar_pdf():
    from fpdf import FPDF

    conn = get_db()
    linhas = _linhas_ordenadas(conn)

    pdf = FPDF(orientation="L", unit="mm", format="A4")
    pdf.set_auto_page_break(auto=True, margin=12)
    pdf.add_page()
    pdf.set_font("Helvetica", "B", 14)
    pdf.cell(0, 10, "Ligações", ln=1)
    pdf.set_font("Helvetica", "", 9)

    # Larguras simples com texto cortado (com "…" se passar do espaço) --
    # tentar quebrar linha em várias alturas por célula com fpdf2 dá bug
    # de alinhamento fácil; pra uma exportação de apoio, previsível e
    # sem quebrar é melhor que bonito.
    larguras = [22, 45, 38, 45, 60, 67]
    pdf.set_font("Helvetica", "B", 9)
    pdf.set_fill_color(10, 125, 103)
    pdf.set_text_color(255, 255, 255)
    for (campo, rotulo), largura in zip(COLUNAS, larguras):
        pdf.cell(largura, 8, rotulo, border=1, fill=True)
    pdf.ln()
    pdf.set_text_color(0, 0, 0)
    pdf.set_font("Helvetica", "", 8)

    def _cortar(texto, largura_mm):
        max_chars = max(6, int(largura_mm / 1.7))
        texto = str(texto or "")
        # A fonte padrão (Helvetica) só cobre Latin-1 -- troca qualquer
        # caractere fora disso (emoji etc) por "?" em vez de quebrar a
        # exportação inteira por causa de um caractere solto.
        texto = texto.encode("latin-1", "replace").decode("latin-1")
        return texto if len(texto) <= max_chars else texto[: max_chars - 1] + "..."

    for linha in linhas:
        for (campo, _), largura in zip(COLUNAS, larguras):
            pdf.cell(largura, 7, _cortar(linha[campo], largura), border=1)
        pdf.ln()

    saida = bytes(pdf.output())
    buffer = io.BytesIO(saida)
    buffer.seek(0)
    return send_file(buffer, as_attachment=True, download_name="ligacoes.pdf", mimetype="application/pdf")
