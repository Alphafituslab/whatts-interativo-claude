"""
Chamada de voz dentro do Chat interno -- pedido do Clayton
(2026-09-04): "e possivel implantar fazer chamadas de voz no chat
interno? como se eu estivesse fazendo uma ligação porem somente no
chat interno".

É WebRTC: o áudio vai DIRETO de um navegador pro outro, sem passar
pelo servidor. Este arquivo só cuida do "bilhete" -- avisar que alguém
está ligando, e trocar as poucas mensagens técnicas (oferta/resposta
SDP, candidatos ICE) que os dois lados precisam pra se encontrar. Uma
vez que a chamada conecta, o servidor não vê nem ouve nada do áudio.

Só 1 pra 1, porque o chat interno já é sempre entre duas pessoas
(nunca grupo).
"""
import json

from flask import Blueprint, g, jsonify, request

from .. import chat_interno_service, whatsapp_service
from ..context import ApiError, get_db, requires_auth
from .chat_interno import _carregar

bp = Blueprint("chamadas", __name__, url_prefix="/api/v1/chat-interno")


def _now_iso():
    return whatsapp_service._now_iso()


def _outro_lado(conversa, usuario_id):
    if usuario_id == conversa["criado_por_id"]:
        return conversa["participante_id"]
    if usuario_id == conversa["participante_id"]:
        return conversa["criado_por_id"]
    return None


def _limpar_chamadas_travadas(conn):
    """Achado ao vivo (2026-09-04): uma chamada 'atendida' pode ficar
    presa pra sempre se o navegador travar, a rede cair, ou o aviso de
    saída-da-página não disparar a tempo -- e enquanto isso a conversa
    fica bloqueada pra qualquer chamada nova. Chamado no início das
    rotas mais usadas (iniciar/pendente/sinais) -- a de sinais sozinha
    já roda a cada 1s durante QUALQUER chamada ativa no sistema, então
    isto aqui vira, na prática, uma limpeza quase contínua."""
    conn.execute(
        "UPDATE chat_interno_chamadas SET status = 'perdida' "
        "WHERE status = 'chamando' AND datetime(criado_em) < datetime('now', '-60 seconds')"
    )
    conn.execute(
        "UPDATE chat_interno_chamadas SET status = 'encerrada', encerrada_em = ? "
        "WHERE status = 'atendida' "
        "AND datetime(COALESCE(ultimo_ping_em, atendida_em)) < datetime('now', '-30 seconds')",
        (_now_iso(),),
    )
    conn.commit()


def _carregar_chamada(conn, empresa_id, chamada_id):
    # empresa_id da conversa vem de quem CRIOU ela (uc.empresa_id) --
    # mesma regra de chat_interno_service.carregar_conversa, ele nunca
    # muda de lado mesmo que o participante seja trocado ao encaminhar.
    row = conn.execute(
        "SELECT ch.*, uc.empresa_id AS conversa_empresa_id FROM chat_interno_chamadas ch "
        "JOIN chat_interno_conversas c ON c.id = ch.conversa_id "
        "JOIN usuarios uc ON uc.id = c.criado_por_id WHERE ch.id = ?",
        (chamada_id,),
    ).fetchone()
    if row is None or row["conversa_empresa_id"] != empresa_id:
        raise ApiError("Chamada não encontrada.", status=404, codigo="nao_encontrado")
    return row


def _chamada_publica(conn, chamada):
    d = dict(chamada)
    d.pop("conversa_empresa_id", None)
    de = conn.execute("SELECT nome, foto_perfil FROM usuarios WHERE id = ?", (d["de_usuario_id"],)).fetchone()
    d["de_nome"] = de["nome"] if de else None
    d["de_foto"] = de["foto_perfil"] if de else None
    return d


@bp.post("/conversas/<int:conversa_id>/chamadas")
@requires_auth
def iniciar(conversa_id):
    usuario = g.usuario_atual
    conn = get_db()
    _limpar_chamadas_travadas(conn)
    conversa = _carregar(conn, usuario["empresa_id"], conversa_id)
    outro = _outro_lado(conversa, usuario["id"])
    if outro is None:
        raise ApiError("Esta conversa é privada entre outras duas pessoas.", status=403, codigo="sem_permissao")

    # Pedido do Clayton (2026-09-04): avisar na hora se o colega está
    # offline, em vez de deixar tocar pro vácuo até estourar os 60s.
    destino = conn.execute(
        "SELECT ultimo_acesso, offline_forcado, ausente, nome FROM usuarios WHERE id = ?", (outro,)
    ).fetchone()
    if destino is None or not whatsapp_service.usuario_esta_online(
        destino["ultimo_acesso"], destino["offline_forcado"], destino["ausente"]
    ):
        raise ApiError(f"{destino['nome'] if destino else 'Colega'} está offline agora — não é possível ligar.",
                        status=409, codigo="operador_offline")

    # Já existe uma chamada em andamento nessa conversa (de qualquer um
    # dos dois lados)? Não deixa começar outra por cima -- confunde o
    # sinal de quem está ligando pra quem.
    ativa = conn.execute(
        "SELECT id FROM chat_interno_chamadas WHERE conversa_id = ? AND status IN ('chamando','atendida')",
        (conversa_id,),
    ).fetchone()
    if ativa is not None:
        raise ApiError("Já tem uma chamada em andamento nesta conversa.", status=409, codigo="chamada_em_andamento")

    # Sinal de ocupado -- pedido do Clayton (2026-09-04): quem está
    # ligando precisa saber na hora que o outro colega já está numa
    # chamada (com QUALQUER pessoa, não só nesta conversa), em vez de
    # ficar tocando pro vácuo ou criar uma segunda chamada por cima.
    ocupado = conn.execute(
        "SELECT id FROM chat_interno_chamadas WHERE status IN ('chamando','atendida') "
        "AND (de_usuario_id = ? OR para_usuario_id = ?)",
        (outro, outro),
    ).fetchone()
    if ocupado is not None:
        raise ApiError(f"{conversa['participante_nome'] if outro == conversa['participante_id'] else conversa['criado_por_nome']} está em outra chamada agora.",
                        status=409, codigo="usuario_ocupado")

    agora = _now_iso()
    cur = conn.execute(
        "INSERT INTO chat_interno_chamadas (conversa_id, de_usuario_id, para_usuario_id, status, criado_em) "
        "VALUES (?, ?, ?, 'chamando', ?)",
        (conversa_id, usuario["id"], outro, agora),
    )
    conn.commit()
    chamada = _carregar_chamada(conn, usuario["empresa_id"], cur.lastrowid)
    return jsonify(_chamada_publica(conn, chamada)), 201


@bp.get("/chamadas/pendente")
@requires_auth
def pendente():
    """Consultado por TODA tela (não só o Chat interno) a cada poucos
    segundos, pra tocar o toque de chamada mesmo se a pessoa estiver
    olhando o Dashboard ou uma conversa de cliente -- igual já acontece
    com mensagem nova."""
    usuario = g.usuario_atual
    conn = get_db()
    # 60s sem ninguém atender: considera "perdida" sozinho, pra não
    # ficar tocando pra sempre se o navegador de quem ligou travou ou
    # a pessoa fechou a aba sem desligar.
    _limpar_chamadas_travadas(conn)
    row = conn.execute(
        "SELECT ch.* FROM chat_interno_chamadas ch "
        "JOIN chat_interno_conversas c ON c.id = ch.conversa_id "
        "JOIN usuarios uc ON uc.id = c.criado_por_id "
        "WHERE ch.para_usuario_id = ? AND ch.status = 'chamando' AND uc.empresa_id = ? "
        "ORDER BY ch.id DESC LIMIT 1",
        (usuario["id"], usuario["empresa_id"]),
    ).fetchone()
    if row is None:
        return jsonify(None)
    return jsonify(_chamada_publica(conn, row))


@bp.get("/chamadas/<int:chamada_id>")
@requires_auth
def detalhe(chamada_id):
    usuario = g.usuario_atual
    conn = get_db()
    chamada = _carregar_chamada(conn, usuario["empresa_id"], chamada_id)
    if usuario["id"] not in (chamada["de_usuario_id"], chamada["para_usuario_id"]):
        raise ApiError("Sem acesso a esta chamada.", status=403, codigo="sem_permissao")
    return jsonify(_chamada_publica(conn, chamada))


@bp.post("/chamadas/<int:chamada_id>/atender")
@requires_auth
def atender(chamada_id):
    usuario = g.usuario_atual
    conn = get_db()
    chamada = _carregar_chamada(conn, usuario["empresa_id"], chamada_id)
    if usuario["id"] != chamada["para_usuario_id"]:
        raise ApiError("Só quem recebeu a chamada pode atender.", status=403, codigo="sem_permissao")
    if chamada["status"] != "chamando":
        raise ApiError("Esta chamada não está mais disponível.", status=409, codigo="chamada_indisponivel")
    conn.execute(
        "UPDATE chat_interno_chamadas SET status = 'atendida', atendida_em = ? WHERE id = ?",
        (_now_iso(), chamada_id),
    )
    conn.commit()
    return jsonify({"ok": True})


@bp.post("/chamadas/<int:chamada_id>/recusar")
@requires_auth
def recusar(chamada_id):
    usuario = g.usuario_atual
    conn = get_db()
    chamada = _carregar_chamada(conn, usuario["empresa_id"], chamada_id)
    if usuario["id"] != chamada["para_usuario_id"]:
        raise ApiError("Só quem recebeu a chamada pode recusar.", status=403, codigo="sem_permissao")
    if chamada["status"] == "chamando":
        conn.execute("UPDATE chat_interno_chamadas SET status = 'recusada' WHERE id = ?", (chamada_id,))
        conn.commit()
    return jsonify({"ok": True})


@bp.post("/chamadas/<int:chamada_id>/encerrar")
@requires_auth
def encerrar(chamada_id):
    """Qualquer um dos dois lados pode desligar -- de quem ligou
    (desistiu / discou errado) ou de quem atendeu (encerrou a
    ligação)."""
    usuario = g.usuario_atual
    conn = get_db()
    chamada = _carregar_chamada(conn, usuario["empresa_id"], chamada_id)
    if usuario["id"] not in (chamada["de_usuario_id"], chamada["para_usuario_id"]):
        raise ApiError("Sem acesso a esta chamada.", status=403, codigo="sem_permissao")
    if chamada["status"] in ("encerrada", "recusada", "perdida"):
        return jsonify({"ok": True})  # já foi -- o outro lado desligou primeiro, sem problema
    agora = _now_iso()
    duracao = None
    if chamada["status"] == "atendida" and chamada["atendida_em"]:
        duracao = whatsapp_service._diferenca_minutos(chamada["atendida_em"], agora) * 60
    novo_status = "encerrada" if chamada["status"] == "atendida" else (
        "perdida" if usuario["id"] == chamada["para_usuario_id"] else "encerrada"
    )
    conn.execute(
        "UPDATE chat_interno_chamadas SET status = ?, encerrada_em = ?, duracao_seg = ? WHERE id = ?",
        (novo_status, agora, int(duracao) if duracao is not None else None, chamada_id),
    )
    conn.commit()
    return jsonify({"ok": True})


@bp.post("/chamadas/<int:chamada_id>/sinal")
@requires_auth
def enviar_sinal(chamada_id):
    usuario = g.usuario_atual
    conn = get_db()
    chamada = _carregar_chamada(conn, usuario["empresa_id"], chamada_id)
    if usuario["id"] not in (chamada["de_usuario_id"], chamada["para_usuario_id"]):
        raise ApiError("Sem acesso a esta chamada.", status=403, codigo="sem_permissao")
    dados = request.get_json(silent=True) or {}
    tipo = dados.get("tipo")
    if tipo not in ("oferta", "resposta", "candidato", "encerrar"):
        raise ApiError("Tipo de sinal inválido.", status=400)
    conn.execute(
        "INSERT INTO chat_interno_chamadas_sinais (chamada_id, de_usuario_id, tipo, dados, criado_em) VALUES (?, ?, ?, ?, ?)",
        (chamada_id, usuario["id"], tipo, json.dumps(dados.get("dados")), _now_iso()),
    )
    conn.commit()
    return jsonify({"ok": True}), 201


@bp.get("/chamadas/<int:chamada_id>/sinais")
@requires_auth
def listar_sinais(chamada_id):
    """Só devolve o que o OUTRO lado mandou -- cada um só precisa ouvir
    o sinal do parceiro, nunca o próprio eco de volta."""
    usuario = g.usuario_atual
    conn = get_db()
    chamada = _carregar_chamada(conn, usuario["empresa_id"], chamada_id)
    if usuario["id"] not in (chamada["de_usuario_id"], chamada["para_usuario_id"]):
        raise ApiError("Sem acesso a esta chamada.", status=403, codigo="sem_permissao")
    if chamada["status"] == "atendida":
        conn.execute("UPDATE chat_interno_chamadas SET ultimo_ping_em = ? WHERE id = ?", (_now_iso(), chamada_id))
        conn.commit()
    _limpar_chamadas_travadas(conn)
    apos = int(request.args.get("apos") or 0)
    rows = conn.execute(
        "SELECT id, tipo, dados, criado_em FROM chat_interno_chamadas_sinais "
        "WHERE chamada_id = ? AND id > ? AND de_usuario_id != ? ORDER BY id",
        (chamada_id, apos, usuario["id"]),
    ).fetchall()
    itens = []
    for r in rows:
        d = dict(r)
        try:
            d["dados"] = json.loads(d["dados"])
        except (TypeError, ValueError):
            d["dados"] = None
        itens.append(d)
    return jsonify(itens)
