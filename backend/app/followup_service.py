"""
Follow-up: garante que nenhum cliente fique esquecido.

Diferente do alerta de SLA (que é em MINUTOS e cobra resposta rápida
dentro do atendimento), aqui a conta é em DIAS: o atendimento não foi
finalizado e ninguém falou com o cliente há tempo demais.

A regra central, na ordem em que é avaliada:

    1. Conversa finalizada        -> sai do monitoramento, ponto final.
    2. Follow-up adiado           -> silencia até a data do adiamento.
    3. Tem contato programado     -> espera a data programada, mesmo que
                                     já tenha passado do prazo de dias.
    4. Dias sem interação > prazo -> FOLLOW-UP NECESSÁRIO.

O item 3 é o que evita o erro mais comum desse tipo de recurso: ficar
cobrando o operador de um cliente que ele JÁ combinou de retornar semana
que vem.
"""
import datetime

ETAPAS = [
    ("novo", "Novo atendimento"),
    ("em_atendimento", "Em atendimento"),
    ("aguardando_cliente", "Aguardando cliente"),
    ("aguardando_interno", "Aguardando retorno interno"),
    ("followup", "Follow-up necessário"),
    ("agendado", "Agendado"),
    ("finalizado", "Finalizado"),
]
ETAPAS_VALIDAS = {e for e, _ in ETAPAS}
ETAPA_ROTULO = dict(ETAPAS)

PRIORIDADES = [("baixa", "Baixa"), ("normal", "Normal"), ("alta", "Alta")]
PRIORIDADES_VALIDAS = {p for p, _ in PRIORIDADES}

FORMAS_CONTATO = ["whatsapp", "ligacao", "email", "outro"]

DIAS_PADRAO = 7


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


def registrar_historico(conn, conversa_id, usuario_id, acao, detalhe=None):
    """Nada aqui é apagado — é a trilha de auditoria do follow-up."""
    conn.execute(
        "INSERT INTO whatsapp_followup_historico (conversa_id, usuario_id, acao, detalhe, criado_em) VALUES (?, ?, ?, ?, ?)",
        (conversa_id, usuario_id, acao, detalhe, _now_iso()),
    )


def obter_prazos(conn, empresa_id):
    """Prazo padrão da empresa + as exceções por setor/prioridade/etapa."""
    cfg = conn.execute(
        "SELECT followup_dias FROM configuracoes_whatsapp WHERE empresa_id = ?", (empresa_id,)
    ).fetchone()
    padrao = (cfg["followup_dias"] if cfg else None) or DIAS_PADRAO
    excecoes = {}
    for r in conn.execute(
        "SELECT criterio, valor, dias FROM whatsapp_followup_prazos WHERE empresa_id = ?", (empresa_id,)
    ).fetchall():
        excecoes[(r["criterio"], r["valor"])] = r["dias"]
    return padrao, excecoes


def prazo_da_conversa(conversa, padrao, excecoes):
    """Do mais específico pro mais geral: prioridade manda mais que
    etapa, que manda mais que setor. Assim "cliente estratégico: 1 dia"
    ganha do prazo do setor dele."""
    for chave in (
        ("prioridade", conversa.get("prioridade")),
        ("etapa", conversa.get("etapa")),
        ("setor", conversa.get("menu_setor")),
    ):
        if chave[1] and chave in excecoes:
            return excecoes[chave]
    return padrao


def avaliar_conversa(conversa, padrao, excecoes, agora=None):
    """Devolve a situação de follow-up de UMA conversa, ou None se ela
    não deve ser monitorada. Função pura (não toca no banco) pra poder
    ser testada isoladamente."""
    agora = agora or _now()

    if conversa.get("status") == "fechada" or conversa.get("etapa") == "finalizado":
        return None

    prazo_dias = prazo_da_conversa(conversa, padrao, excecoes)

    # Última vez que houve QUALQUER interação nos dois sentidos.
    marcos = [
        _parse(conversa.get("ultima_msg_cliente_em")),
        _parse(conversa.get("ultima_msg_operador_em")),
        _parse(conversa.get("ultima_mensagem_em")),
        _parse(conversa.get("criado_em")),
    ]
    ultimo_contato = max([m for m in marcos if m], default=None)
    dias_parado = (agora - ultimo_contato).days if ultimo_contato else 0

    base = {
        "conversa_id": conversa.get("id"),
        "dias_parado": dias_parado,
        "prazo_dias": prazo_dias,
        "ultimo_contato_em": ultimo_contato.strftime("%Y-%m-%dT%H:%M:%S.%fZ") if ultimo_contato else None,
        "proximo_contato_em": conversa.get("proximo_contato_em"),
        "prioridade": conversa.get("prioridade") or "normal",
        "etapa": conversa.get("etapa") or "novo",
    }

    # 2. Adiado: silencia até a data escolhida.
    adiado = _parse(conversa.get("followup_adiado_ate"))
    if adiado and adiado > agora:
        return {**base, "situacao": "adiado", "quando": conversa.get("followup_adiado_ate")}

    # 3. Tem contato programado: manda mais que o prazo de dias.
    agendado = _parse(conversa.get("proximo_contato_em"))
    if agendado:
        if agendado > agora:
            return {**base, "situacao": "agendado", "quando": conversa.get("proximo_contato_em")}
        # Passou da hora combinada — isso é mais urgente que o abandono
        # comum: o operador prometeu retorno e não cumpriu.
        atraso_h = (agora - agendado).total_seconds() / 3600
        return {
            **base,
            "situacao": "agendado_vencido",
            "quando": conversa.get("proximo_contato_em"),
            "horas_de_atraso": round(atraso_h, 1),
        }

    # 4. Sem agendamento: vale a régua de dias.
    if dias_parado >= prazo_dias:
        return {**base, "situacao": "atrasado"}
    if dias_parado >= max(1, prazo_dias - 1):
        return {**base, "situacao": "proximo_do_vencimento"}
    return {**base, "situacao": "em_dia"}


# Situações que exigem ação de alguém (é o que o contador do sino conta).
SITUACOES_PENDENTES = {"atrasado", "agendado_vencido"}


def listar(conn, empresa_id, usuario_id=None, setores=None, apenas_pendentes=False):
    """Situação de follow-up das conversas abertas. usuario_id/setores
    aplicam a mesma régua de visibilidade do resto do sistema: cada um
    vê o que é dele, admin (usuario_id=None) vê tudo.

    setores é uma LISTA porque a mesma pessoa pode atender mais de um
    setor do menu (ex.: Televendas e Financeiro)."""
    condicoes = ["ct.empresa_id = ?", "c.excluida_em IS NULL", "c.arquivada = 0", "c.status = 'aberta'"]
    params = [empresa_id]
    if usuario_id is not None:
        meus = [x for x in (setores or []) if x]
        if meus:
            marcadores = ",".join("?" * len(meus))
            condicoes.append(
                f"(c.atribuida_usuario_id = ? OR (c.atribuida_usuario_id IS NULL "
                f"AND c.menu_setor IS NOT NULL AND c.menu_setor IN ({marcadores})))"
            )
            params.extend([usuario_id, *meus])
        else:
            condicoes.append("c.atribuida_usuario_id = ?")
            params.append(usuario_id)

    linhas = conn.execute(
        f"""
        SELECT c.*, ct.telefone, ct.nome AS contato_nome, u.nome AS responsavel_nome
        FROM whatsapp_conversas c
        JOIN whatsapp_contatos ct ON ct.id = c.contato_id
        LEFT JOIN usuarios u ON u.id = c.atribuida_usuario_id
        WHERE {' AND '.join(condicoes)}
        """,
        params,
    ).fetchall()

    padrao, excecoes = obter_prazos(conn, empresa_id)
    agora = _now()
    resultado = []
    for linha in linhas:
        conversa = dict(linha)
        situacao = avaliar_conversa(conversa, padrao, excecoes, agora)
        if situacao is None:
            continue
        if apenas_pendentes and situacao["situacao"] not in SITUACOES_PENDENTES:
            continue
        situacao.update({
            "contato_nome": conversa.get("contato_nome") or conversa.get("telefone"),
            "telefone": conversa.get("telefone"),
            "responsavel_nome": conversa.get("responsavel_nome"),
            "responsavel_id": conversa.get("atribuida_usuario_id"),
            "menu_setor": conversa.get("menu_setor"),
        })
        resultado.append(situacao)

    # Mais urgente primeiro: quem prometeu retorno e furou, depois quem
    # está parado há mais tempo.
    ordem = {"agendado_vencido": 0, "atrasado": 1, "proximo_do_vencimento": 2, "agendado": 3, "adiado": 4, "em_dia": 5}
    resultado.sort(key=lambda s: (ordem.get(s["situacao"], 9), -s["dias_parado"]))
    return resultado


def resumo(conn, empresa_id, usuario_id=None, setores=None):
    """Números do sino: o que precisa de ação, o que está agendado."""
    itens = listar(conn, empresa_id, usuario_id, setores)
    hoje = _now().date()

    def _mesmo_dia(iso):
        d = _parse(iso)
        return d is not None and d.date() == hoje

    return {
        "atrasados": sum(1 for i in itens if i["situacao"] == "atrasado"),
        "agendados_vencidos": sum(1 for i in itens if i["situacao"] == "agendado_vencido"),
        "para_hoje": sum(1 for i in itens if i["situacao"] == "agendado" and _mesmo_dia(i.get("quando"))),
        "agendados": sum(1 for i in itens if i["situacao"] == "agendado"),
        "proximos_do_vencimento": sum(1 for i in itens if i["situacao"] == "proximo_do_vencimento"),
        "total_pendente": sum(1 for i in itens if i["situacao"] in SITUACOES_PENDENTES),
    }
