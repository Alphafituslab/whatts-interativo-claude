"""
Chat interno privado entre colaboradores/setores — separado das
conversas de clientes. Sempre 1-para-1: quem inicia escolhe um setor e
um colaborador específico daquele setor; só os dois (mais admin, mesma
régua de supervisão das conversas de clientes) veem a conversa. Pode
ser encaminhada pra outra pessoa/setor sem perder o histórico — troca
só quem está do lado "participante", quem iniciou nunca muda (ver
migrations/schema_012_chat_interno.sql).
"""
import datetime


def _now_iso():
    return datetime.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def buscar_conversa_existente(conn, usuario_a: int, usuario_b: int):
    """Um par de pessoas tem no máximo UMA conversa interna — nunca cria
    outra do zero se já existe uma entre elas (mesmo fechada; nesse caso
    reaproveita e reabre). Busca nos dois sentidos porque tanto faz quem
    criou originalmente."""
    row = conn.execute(
        """
        SELECT id FROM chat_interno_conversas
        WHERE (criado_por_id = ? AND participante_id = ?) OR (criado_por_id = ? AND participante_id = ?)
        ORDER BY id DESC LIMIT 1
        """,
        (usuario_a, usuario_b, usuario_b, usuario_a),
    ).fetchone()
    return row["id"] if row else None


def iniciar_conversa(conn, criado_por_id: int, participante_id: int, setor_destino: str, texto: str = None):
    agora = _now_iso()
    cur = conn.execute(
        """
        INSERT INTO chat_interno_conversas
            (criado_por_id, participante_id, setor_destino, criado_em, nao_lidas_participante)
        VALUES (?, ?, ?, ?, ?)
        """,
        (criado_por_id, participante_id, setor_destino, agora, 1 if texto else 0),
    )
    conversa_id = cur.lastrowid
    if texto:
        _inserir_mensagem(conn, conversa_id, criado_por_id, texto)
        _atualizar_preview(conn, conversa_id, texto, agora)
    return conversa_id


def _inserir_mensagem(conn, conversa_id, usuario_id, texto, tipo="texto", midia_url=None, nome_arquivo=None):
    agora = _now_iso()
    conn.execute(
        """
        INSERT INTO chat_interno_mensagens (conversa_id, usuario_id, texto, tipo, midia_url, nome_arquivo, criado_em)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (conversa_id, usuario_id, texto, tipo, midia_url, nome_arquivo, agora),
    )
    return agora


def _atualizar_preview(conn, conversa_id, texto, agora):
    conversa = conn.execute("SELECT criado_por_id, participante_id FROM chat_interno_conversas WHERE id = ?", (conversa_id,)).fetchone()
    conn.execute(
        "UPDATE chat_interno_conversas SET ultima_mensagem_em = ?, ultima_mensagem_preview = ? WHERE id = ?",
        (agora, (texto or "")[:120], conversa_id),
    )


SEGUNDOS_DIGITANDO = 6


def marcar_digitando(conn, conversa_id: int, lado: str):
    ate = (datetime.datetime.utcnow() + datetime.timedelta(seconds=SEGUNDOS_DIGITANDO)).strftime("%Y-%m-%dT%H:%M:%S.%fZ")
    campo = "digitando_criador_ate" if lado == "criador" else "digitando_participante_ate"
    conn.execute(f"UPDATE chat_interno_conversas SET {campo} = ? WHERE id = ?", (ate, conversa_id))


def enviar_mensagem(conn, conversa_id: int, usuario_id: int, texto: str, tipo="texto", midia_url=None, nome_arquivo=None):
    conversa = conn.execute("SELECT * FROM chat_interno_conversas WHERE id = ?", (conversa_id,)).fetchone()
    agora = _inserir_mensagem(conn, conversa_id, usuario_id, texto, tipo, midia_url, nome_arquivo)
    _atualizar_preview(conn, conversa_id, texto if tipo == "texto" else {"imagem": "📷 Imagem", "video": "🎥 Vídeo", "documento": "📄 Documento", "audio": "🎵 Áudio"}.get(tipo, "📎 Anexo"), agora)
    # Quem mandou não soma não-lida pra si mesmo — só pro outro lado.
    campo = "nao_lidas_participante" if usuario_id == conversa["criado_por_id"] else "nao_lidas_criador"
    conn.execute(f"UPDATE chat_interno_conversas SET status = 'aberta', fechada_em = NULL, {campo} = {campo} + 1 WHERE id = ?", (conversa_id,))


def obter_apelidos(conn, usuario_id: int):
    """Apelidos que ESSE usuário definiu pra colegas — só ele vê, o
    cadastro real da outra pessoa não muda pra mais ninguém."""
    rows = conn.execute(
        "SELECT alvo_usuario_id, apelido FROM usuarios_apelidos WHERE usuario_id = ?", (usuario_id,)
    ).fetchall()
    return {r["alvo_usuario_id"]: r["apelido"] for r in rows}


def definir_apelido(conn, usuario_id: int, alvo_usuario_id: int, apelido: str):
    apelido = (apelido or "").strip() or None
    if apelido is None:
        conn.execute("DELETE FROM usuarios_apelidos WHERE usuario_id = ? AND alvo_usuario_id = ?", (usuario_id, alvo_usuario_id))
        return
    existe = conn.execute(
        "SELECT 1 FROM usuarios_apelidos WHERE usuario_id = ? AND alvo_usuario_id = ?", (usuario_id, alvo_usuario_id)
    ).fetchone()
    if existe:
        conn.execute(
            "UPDATE usuarios_apelidos SET apelido = ?, atualizado_em = ? WHERE usuario_id = ? AND alvo_usuario_id = ?",
            (apelido, _now_iso(), usuario_id, alvo_usuario_id),
        )
    else:
        conn.execute(
            "INSERT INTO usuarios_apelidos (usuario_id, alvo_usuario_id, apelido, atualizado_em) VALUES (?, ?, ?, ?)",
            (usuario_id, alvo_usuario_id, apelido, _now_iso()),
        )


def _marcar_online(conversas):
    """Traduz o último acesso de cada lado em online/offline aqui no
    servidor — a tela não precisa conhecer a regra (nem receber o horário
    de acesso de ninguém, que é informação interna)."""
    from . import whatsapp_service
    for c in conversas:
        c["criado_por_online"] = whatsapp_service.usuario_esta_online(c.pop("_uc_acesso", None), c.pop("_uc_off", 0))
        c["participante_online"] = whatsapp_service.usuario_esta_online(c.pop("_up_acesso", None), c.pop("_up_off", 0))
    return conversas


def _aplicar_apelidos(conversas, apelidos):
    for c in conversas:
        if c["criado_por_id"] in apelidos:
            c["criado_por_nome"] = apelidos[c["criado_por_id"]]
        if c.get("participante_id") in apelidos:
            c["participante_nome"] = apelidos[c["participante_id"]]
    return conversas


def listar_conversas(conn, usuario_id: int, incluir_encerradas: bool = False, empresa_id_admin: int = None):
    """Por padrão só mostra as em aberto — encerrar uma conversa faz ela
    sumir da lista (sem apagar nada, ver fechar_conversa), pra tela não
    ficar poluída de conversas antigas. incluir_encerradas=True mostra só
    as encerradas (ver GET /chat-interno/conversas?encerradas=1).

    empresa_id_admin: só um admin deveria pedir isso — em vez de filtrar
    por quem participa, mostra TODAS as conversas da empresa (mesma
    régua de supervisão de 'escopo=todas' nas conversas de clientes)."""
    condicao_status = "c.status = 'fechada'" if incluir_encerradas else "c.status = 'aberta'"
    if empresa_id_admin is not None:
        condicao_dono = "uc.empresa_id = ?"
        params = (empresa_id_admin,)
    else:
        condicao_dono = "(c.criado_por_id = ? OR c.participante_id = ?)"
        params = (usuario_id, usuario_id)
    rows = conn.execute(
        f"""
        SELECT c.*, uc.nome AS criado_por_nome, up.nome AS participante_nome, uc.empresa_id AS empresa_id,
               uc.foto_perfil AS criado_por_foto, up.foto_perfil AS participante_foto,
               uc.ultimo_acesso AS _uc_acesso, uc.offline_forcado AS _uc_off,
               up.ultimo_acesso AS _up_acesso, up.offline_forcado AS _up_off
        FROM chat_interno_conversas c
        JOIN usuarios uc ON uc.id = c.criado_por_id
        LEFT JOIN usuarios up ON up.id = c.participante_id
        WHERE {condicao_dono} AND {condicao_status}
        ORDER BY COALESCE(c.ultima_mensagem_em, c.criado_em) DESC
        """,
        params,
    ).fetchall()
    conversas = _marcar_online([dict(r) for r in rows])
    return _aplicar_apelidos(conversas, obter_apelidos(conn, usuario_id))


def carregar_conversa(conn, conversa_id: int):
    """empresa_id vem sempre de quem CRIOU a conversa — ele nunca muda de
    lado (só o participante é trocado ao encaminhar), então é a fonte
    confiável de qual empresa esta conversa pertence."""
    row = conn.execute(
        """
        SELECT c.*, uc.nome AS criado_por_nome, up.nome AS participante_nome, uc.empresa_id AS empresa_id,
               uc.foto_perfil AS criado_por_foto, up.foto_perfil AS participante_foto,
               uc.ultimo_acesso AS _uc_acesso, uc.offline_forcado AS _uc_off,
               up.ultimo_acesso AS _up_acesso, up.offline_forcado AS _up_off
        FROM chat_interno_conversas c
        JOIN usuarios uc ON uc.id = c.criado_por_id
        LEFT JOIN usuarios up ON up.id = c.participante_id
        WHERE c.id = ?
        """,
        (conversa_id,),
    ).fetchone()
    return _marcar_online([dict(row)])[0] if row else None


def listar_mensagens(conn, conversa_id: int, lado: str = None, incluir_excluidas: bool = False):
    """lado: 'criador' ou 'participante' quando quem está lendo é
    realmente uma das duas pontas da conversa — zera o contador de
    não-lida DELE. None quando é um admin só espiando (aba "Todas") —
    nesse caso não mexe em nada, ninguém pode saber que foi visto."""
    # incluir_excluidas: só o admin, em supervisão — vê o que foi apagado
    # e por quem, em vez de a mensagem sumir sem deixar rastro.
    filtro = "" if incluir_excluidas else " AND m.excluida_em IS NULL"
    rows = conn.execute(
        f"SELECT m.*, ue.nome AS excluida_por_nome FROM chat_interno_mensagens m "
        f"LEFT JOIN usuarios ue ON ue.id = m.excluida_por "
        f"WHERE m.conversa_id = ?{filtro} ORDER BY m.criado_em, m.id",
        (conversa_id,),
    ).fetchall()
    if lado in ("criador", "participante"):
        campo = "nao_lidas_criador" if lado == "criador" else "nao_lidas_participante"
        # Grava TAMBÉM quando foi lido: é o que faz o "visualizado"
        # aparecer pro outro lado (ver visto_criador_em/visto_participante_em).
        campo_visto = "visto_criador_em" if lado == "criador" else "visto_participante_em"
        conn.execute(
            f"UPDATE chat_interno_conversas SET {campo} = 0, {campo_visto} = ? WHERE id = ?",
            (_now_iso(), conversa_id),
        )
    return [dict(r) for r in rows]


def encaminhar_conversa(conn, conversa_id: int, novo_participante_id: int, novo_setor: str, encaminhado_por: int):
    conversa = conn.execute("SELECT participante_id FROM chat_interno_conversas WHERE id = ?", (conversa_id,)).fetchone()
    conn.execute(
        "UPDATE chat_interno_conversas SET participante_id = ?, setor_destino = ?, nao_lidas_participante = 1 WHERE id = ?",
        (novo_participante_id, novo_setor, conversa_id),
    )
    conn.execute(
        """
        INSERT INTO chat_interno_encaminhamentos (conversa_id, de_usuario_id, para_usuario_id, setor_destino, encaminhado_por, criado_em)
        VALUES (?, ?, ?, ?, ?, ?)
        """,
        (conversa_id, conversa["participante_id"], novo_participante_id, novo_setor, encaminhado_por, _now_iso()),
    )


def fechar_conversa(conn, conversa_id: int):
    conn.execute("UPDATE chat_interno_conversas SET status = 'fechada', fechada_em = ? WHERE id = ?", (_now_iso(), conversa_id))


def reabrir_conversa(conn, conversa_id: int):
    conn.execute("UPDATE chat_interno_conversas SET status = 'aberta', fechada_em = NULL WHERE id = ?", (conversa_id,))
