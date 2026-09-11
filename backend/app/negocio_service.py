"""
CRM de vendas (funil) -- pedido do Clayton (2026-09-11): "bora construir
algo top... tudo monitoravel por mim". Um "negocio" e uma oportunidade
de venda -- vai passando por estagios ate virar "ganho" ou "perdido".

Diferente do marcador antigo (whatsapp_negociacoes_fechadas, so um "quem
vendeu e quando" sem valor nem estagio), aqui da pra acompanhar o funil
inteiro: quantos leads, quantos viram proposta, quantos fecham, quanto
vale cada etapa.

O botao "Marcar negociacao fechada" que ja existia continua funcionando
do jeito de sempre (o proprio marcador antigo nao muda) -- ele so passa
a chamar sincronizar_com_resultado() por cima, que abre/fecha o negocio
correspondente no funil automaticamente. Ninguem precisa aprender uma
tela nova pra continuar registrando venda do jeito que ja fazia.
"""
import datetime

from .context import ApiError

ESTAGIOS_FUNIL = [
    {"chave": "lead", "nome": "Novo lead", "cor": "#6b7280"},
    {"chave": "contato", "nome": "Contato feito", "cor": "#3b82f6"},
    {"chave": "proposta", "nome": "Proposta enviada", "cor": "#f59e0b"},
    {"chave": "negociacao", "nome": "Em negociação", "cor": "#8b5cf6"},
    {"chave": "ganho", "nome": "Ganho", "cor": "#1fa855", "terminal": True},
    {"chave": "perdido", "nome": "Perdido", "cor": "#e5484d", "terminal": True},
]
_CHAVES_VALIDAS = {e["chave"] for e in ESTAGIOS_FUNIL}
_TERMINAIS = {e["chave"] for e in ESTAGIOS_FUNIL if e.get("terminal")}


def _now():
    return datetime.datetime.utcnow()


def _now_iso():
    return _now().strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def _parse(iso):
    if not iso:
        return None
    try:
        return datetime.datetime.strptime(iso, "%Y-%m-%dT%H:%M:%S.%fZ")
    except (ValueError, TypeError):
        try:
            return datetime.datetime.strptime(iso, "%Y-%m-%dT%H:%M:%SZ")
        except (ValueError, TypeError):
            return None


def _estagio_valido(chave):
    return chave in _CHAVES_VALIDAS


def _eh_terminal(chave):
    return chave in _TERMINAIS


def listar(conn, empresa_id, responsavel_id=None):
    """Todo negócio da empresa (aberto ou fechado) com o nome do contato
    e do responsável já resolvidos -- o Kanban usa isso direto, sem
    precisar de mais nenhuma consulta por card."""
    query = (
        "SELECT n.*, ct.nome AS contato_nome, ct.telefone AS contato_telefone, ct.foto_url AS contato_foto, "
        "u.nome AS responsavel_nome "
        "FROM whatsapp_negocios n "
        "JOIN whatsapp_contatos ct ON ct.id = n.contato_id "
        "LEFT JOIN usuarios u ON u.id = n.responsavel_usuario_id "
        "WHERE n.empresa_id = ?"
    )
    params = [empresa_id]
    if responsavel_id:
        query += " AND n.responsavel_usuario_id = ?"
        params.append(responsavel_id)
    query += " ORDER BY n.atualizado_em DESC"
    return [dict(r) for r in conn.execute(query, params).fetchall()]


def obter(conn, empresa_id, negocio_id):
    row = conn.execute(
        "SELECT * FROM whatsapp_negocios WHERE id = ? AND empresa_id = ?", (negocio_id, empresa_id)
    ).fetchone()
    if row is None:
        raise ApiError("Negócio não encontrado.", status=404, codigo="nao_encontrado")
    return row


def obter_aberto_por_conversa(conn, conversa_id):
    """O negócio ainda em andamento (não fechado) ligado a essa
    conversa, se tiver algum -- usado pela integração com o botão
    "Marcar negociação fechada" pra saber se move um negócio existente
    ou cria um novo já fechado."""
    return conn.execute(
        "SELECT * FROM whatsapp_negocios WHERE conversa_id = ? AND resultado IS NULL ORDER BY criado_em DESC LIMIT 1",
        (conversa_id,),
    ).fetchone()


def criar(conn, empresa_id, contato_id, conversa_id, titulo, valor, responsavel_usuario_id, criado_por_id):
    agora = _now_iso()
    cur = conn.execute(
        "INSERT INTO whatsapp_negocios (empresa_id, contato_id, conversa_id, titulo, valor, estagio, "
        "responsavel_usuario_id, criado_por_id, criado_em, atualizado_em) VALUES (?, ?, ?, ?, ?, 'lead', ?, ?, ?, ?)",
        (empresa_id, contato_id, conversa_id, titulo, valor, responsavel_usuario_id, criado_por_id, agora, agora),
    )
    return cur.lastrowid


def atualizar(conn, empresa_id, negocio_id, titulo=None, valor=None, responsavel_usuario_id=None):
    obter(conn, empresa_id, negocio_id)  # 404 se não existir/não for da empresa
    campos, valores = [], []
    if titulo is not None:
        campos.append("titulo = ?"); valores.append(titulo)
    if valor is not None:
        campos.append("valor = ?"); valores.append(valor)
    if responsavel_usuario_id is not None:
        campos.append("responsavel_usuario_id = ?"); valores.append(responsavel_usuario_id)
    if not campos:
        return
    campos.append("atualizado_em = ?"); valores.append(_now_iso())
    valores.append(negocio_id)
    conn.execute(f"UPDATE whatsapp_negocios SET {', '.join(campos)} WHERE id = ?", valores)


def mover_estagio(conn, negocio_id, novo_estagio, valor=None, motivo_perda=None):
    """Move o negócio de coluna no Kanban. Cair em 'ganho'/'perdido'
    fecha o negócio (grava fechado_em + resultado); sair de um desses de
    volta pra um estágio aberto reabre (limpa os dois) -- dá pra
    desfazer um fechamento errado sem excluir o negócio."""
    if not _estagio_valido(novo_estagio):
        raise ApiError(f"Estágio inválido: {novo_estagio}.", status=400, codigo="estagio_invalido")
    agora = _now_iso()
    terminal = _eh_terminal(novo_estagio)
    resultado = novo_estagio if terminal else None
    fechado_em = agora if terminal else None
    motivo = motivo_perda if novo_estagio == "perdido" else None
    if valor is not None:
        conn.execute(
            "UPDATE whatsapp_negocios SET estagio=?, atualizado_em=?, resultado=?, fechado_em=?, motivo_perda=?, valor=? WHERE id=?",
            (novo_estagio, agora, resultado, fechado_em, motivo, valor, negocio_id),
        )
    else:
        conn.execute(
            "UPDATE whatsapp_negocios SET estagio=?, atualizado_em=?, resultado=?, fechado_em=?, motivo_perda=? WHERE id=?",
            (novo_estagio, agora, resultado, fechado_em, motivo, negocio_id),
        )


def excluir(conn, empresa_id, negocio_id):
    obter(conn, empresa_id, negocio_id)
    conn.execute("DELETE FROM whatsapp_negocios WHERE id = ?", (negocio_id,))


def sincronizar_com_resultado(conn, empresa_id, conversa_id, resultado, usuario_id, valor=None, motivo_perda=None):
    """Ponte com o fluxo que já existia: sempre que uma conversa é
    marcada com resultado 'venda'/'perdido' (via PUT .../resultado ou ao
    encerrar a conversa com resultado), sincroniza o funil por cima --
    sem mexer no marcador antigo (whatsapp_negociacoes_fechadas), que
    continua gravando do jeito que sempre gravou.

    Se já existir um negócio aberto pra essa conversa, só move ele. Se
    não existir nenhum (a pessoa nunca abriu o Kanban, só usou o botão
    de sempre), cria um novo JÁ FECHADO nesse resultado -- assim toda
    venda, mesmo de quem nunca usou o CRM novo, entra no funil."""
    if resultado not in ("venda", "perdido"):
        return None
    novo_estagio = "ganho" if resultado == "venda" else "perdido"
    negocio = obter_aberto_por_conversa(conn, conversa_id)
    if negocio is None:
        conversa = conn.execute(
            "SELECT contato_id, atribuida_usuario_id FROM whatsapp_conversas WHERE id = ?", (conversa_id,)
        ).fetchone()
        if conversa is None:
            return None
        negocio_id = criar(
            conn, empresa_id, conversa["contato_id"], conversa_id, None, valor,
            conversa["atribuida_usuario_id"] or usuario_id, usuario_id,
        )
    else:
        negocio_id = negocio["id"]
    mover_estagio(conn, negocio_id, novo_estagio, valor=valor, motivo_perda=motivo_perda)
    return negocio_id


def funil_resumo(conn, empresa_id, responsavel_id=None):
    """Números do painel: quantidade e valor por estágio, taxa de
    conversão (ganhos / (ganhos+perdidos)), ticket médio dos ganhos e
    tempo médio até fechar."""
    where = "WHERE empresa_id = ?"
    params = [empresa_id]
    if responsavel_id:
        where += " AND responsavel_usuario_id = ?"
        params.append(responsavel_id)
    linhas = conn.execute(
        f"SELECT estagio, COUNT(*) AS n, COALESCE(SUM(valor),0) AS total FROM whatsapp_negocios {where} GROUP BY estagio",
        params,
    ).fetchall()
    por_estagio = {r["estagio"]: {"quantidade": r["n"], "valor_total": r["total"]} for r in linhas}
    estagios = []
    for e in ESTAGIOS_FUNIL:
        dado = por_estagio.get(e["chave"], {"quantidade": 0, "valor_total": 0})
        estagios.append({**e, **dado})

    ganhos = por_estagio.get("ganho", {"quantidade": 0, "valor_total": 0})
    perdidos = por_estagio.get("perdido", {"quantidade": 0, "valor_total": 0})
    total_fechados = ganhos["quantidade"] + perdidos["quantidade"]
    taxa_conversao = round(ganhos["quantidade"] / total_fechados * 100, 1) if total_fechados else 0
    ticket_medio = round(ganhos["valor_total"] / ganhos["quantidade"], 2) if ganhos["quantidade"] else 0

    linhas_tempo = conn.execute(
        f"SELECT criado_em, fechado_em FROM whatsapp_negocios {where} AND resultado = 'ganho' AND fechado_em IS NOT NULL",
        params,
    ).fetchall()
    dias = []
    for r in linhas_tempo:
        c, f = _parse(r["criado_em"]), _parse(r["fechado_em"])
        if c and f:
            dias.append((f - c).total_seconds() / 86400)
    tempo_medio_dias = round(sum(dias) / len(dias), 1) if dias else 0

    return {
        "estagios": estagios,
        "taxa_conversao": taxa_conversao,
        "ticket_medio": ticket_medio,
        "tempo_medio_dias": tempo_medio_dias,
        "ganhos": ganhos,
        "perdidos": perdidos,
    }
