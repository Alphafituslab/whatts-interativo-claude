"""
Envio em massa pro WhatsApp -- pedido do Clayton (2026-09-04): mandar a
mesma mensagem pra vários contatos de uma vez, com a função inteira
configurável (liga/desliga) porque isso tem risco real de banir o
número (a Evolution API não é oficial da Meta -- ver aviso já existente
na tela de Configuração).

Desligado por padrão. Quando ligado, roda em segundo plano (não trava a
tela), espaçado (nunca tudo de uma vez) e passa pelo MESMO freio de
ritmo (verificar_ritmo_envio) que qualquer outro envio -- não é um
canal separado que ignora os limites já configurados, é o mesmo com
mais destinos na fila.
"""
import threading
import time

from flask import Blueprint, g, jsonify, request

from .. import db as db_module
from .. import whatsapp_service
from ..context import ApiError, get_db, requires_admin, requires_auth
from .whatsapp import _classificar_tipo

bp = Blueprint("envio_massa", __name__, url_prefix="/api/v1/whatsapp/envio-massa")


def _now_iso():
    return whatsapp_service._now_iso()


@bp.get("")
@requires_auth
def listar():
    conn = get_db()
    rows = conn.execute(
        "SELECT e.*, u.nome AS criado_por_nome FROM whatsapp_envios_massa e "
        "LEFT JOIN usuarios u ON u.id = e.criado_por "
        "WHERE e.empresa_id = ? ORDER BY e.id DESC LIMIT 50",
        (g.empresa_id,),
    ).fetchall()
    return jsonify([dict(r) for r in rows])


@bp.get("/<int:envio_id>")
@requires_auth
def detalhe(envio_id):
    conn = get_db()
    envio = conn.execute(
        "SELECT * FROM whatsapp_envios_massa WHERE id = ? AND empresa_id = ?", (envio_id, g.empresa_id)
    ).fetchone()
    if envio is None:
        raise ApiError("Envio não encontrado.", status=404, codigo="nao_encontrado")
    itens = conn.execute(
        "SELECT * FROM whatsapp_envios_massa_itens WHERE envio_id = ? ORDER BY id", (envio_id,)
    ).fetchall()
    d = dict(envio)
    d["itens"] = [dict(i) for i in itens]
    return jsonify(d)


@bp.post("")
@requires_admin
def criar():
    """Só admin: o risco (número banido) é da empresa inteira, não só
    de quem clicou."""
    usuario = g.usuario_atual
    conn = get_db()
    config = whatsapp_service.obter_configuracao(conn, g.empresa_id)
    if not config.get("envio_massa_ativo"):
        raise ApiError(
            "Envio em massa está desativado. Ative em Configuração antes de usar.",
            status=403, codigo="envio_massa_desativado",
        )
    dados = request.get_json(silent=True) or {}
    texto = (dados.get("texto") or "").strip()
    midia_url = (dados.get("midia_url") or "").strip() or None
    nome_arquivo = (dados.get("nome_arquivo") or "").strip() or None
    if not texto and not midia_url:
        raise ApiError("Escreva uma mensagem ou anexe um arquivo.", status=400)

    telefones_brutos = [str(t).strip() for t in (dados.get("telefones") or []) if str(t or "").strip()]
    if not telefones_brutos:
        raise ApiError("Escolha pelo menos um destinatário.", status=400)

    destinos = []
    vistos = set()
    for bruto in telefones_brutos:
        try:
            tel = whatsapp_service.normalizar_telefone(bruto)
        except ApiError:
            continue
        if tel in vistos:
            continue
        vistos.add(tel)
        contato = whatsapp_service.obter_ou_criar_contato(conn, g.empresa_id, tel)
        if contato.get("eh_grupo"):
            continue  # envio em massa é pra contato de cliente, não grupo
        destinos.append((tel, contato.get("nome") or tel))

    if not destinos:
        raise ApiError("Nenhum dos números escolhidos é válido.", status=400)

    agora = _now_iso()
    cur = conn.execute(
        """INSERT INTO whatsapp_envios_massa (empresa_id, texto, midia_url, nome_arquivo, total, criado_por, criado_em)
           VALUES (?, ?, ?, ?, ?, ?, ?)""",
        (g.empresa_id, texto or None, midia_url, nome_arquivo, len(destinos), usuario["id"], agora),
    )
    envio_id = cur.lastrowid
    for tel, nome in destinos:
        conn.execute(
            """INSERT INTO whatsapp_envios_massa_itens (envio_id, telefone, contato_nome, status)
               VALUES (?, ?, ?, 'pendente')""",
            (envio_id, tel, nome),
        )
    conn.commit()

    t = threading.Thread(
        target=_processar_envio_massa, args=(envio_id, g.empresa_id), daemon=True, name=f"envio-massa-{envio_id}"
    )
    t.start()

    return jsonify({"ok": True, "id": envio_id, "total": len(destinos)}), 201


def _processar_envio_massa(envio_id: int, empresa_id: int):
    """Roda numa thread própria (abre sua própria conexão -- nunca
    reaproveita a da requisição, ela já fechou). Um item por vez,
    espaçado por envio_massa_intervalo_segundos; se o freio de ritmo
    (verificar_ritmo_envio) travar por um instante, espera e tenta de
    novo em vez de desistir na hora -- é exatamente pra isso que ele
    existe, não é um erro de verdade."""
    conn = db_module._connect()
    try:
        config = whatsapp_service.obter_configuracao(conn, empresa_id)
        intervalo = config.get("envio_massa_intervalo_segundos") or 8
        envio = conn.execute("SELECT * FROM whatsapp_envios_massa WHERE id = ?", (envio_id,)).fetchone()
        itens = conn.execute(
            "SELECT * FROM whatsapp_envios_massa_itens WHERE envio_id = ? AND status = 'pendente' ORDER BY id",
            (envio_id,),
        ).fetchall()

        for item in itens:
            sucesso, erro = _enviar_um_item(conn, empresa_id, config, envio, item)
            agora = whatsapp_service._now_iso()
            if sucesso:
                conn.execute(
                    "UPDATE whatsapp_envios_massa_itens SET status = 'enviado', atualizado_em = ? WHERE id = ?",
                    (agora, item["id"]),
                )
                conn.execute("UPDATE whatsapp_envios_massa SET enviados = enviados + 1 WHERE id = ?", (envio_id,))
            else:
                conn.execute(
                    "UPDATE whatsapp_envios_massa_itens SET status = 'falhou', erro = ?, atualizado_em = ? WHERE id = ?",
                    (erro, agora, item["id"]),
                )
                conn.execute("UPDATE whatsapp_envios_massa SET falhados = falhados + 1 WHERE id = ?", (envio_id,))
            conn.commit()
            time.sleep(intervalo)

        conn.execute(
            "UPDATE whatsapp_envios_massa SET status = 'concluido', concluido_em = ? WHERE id = ?",
            (whatsapp_service._now_iso(), envio_id),
        )
        conn.commit()
    except Exception:
        import traceback
        print(f"[envio-massa {envio_id}] erro inesperado:")
        traceback.print_exc()
        try:
            conn.execute(
                "UPDATE whatsapp_envios_massa SET status = 'concluido', concluido_em = ? WHERE id = ?",
                (whatsapp_service._now_iso(), envio_id),
            )
            conn.commit()
        except Exception:
            pass
    finally:
        conn.close()


def _enviar_um_item(conn, empresa_id, config, envio, item):
    """Manda pra UM destino, com até 3 tentativas se for só o freio de
    ritmo pedindo pra esperar (não desiste por causa disso -- é
    exatamente o comportamento esperado, não uma falha real)."""
    telefone = item["telefone"]
    for tentativa in range(3):
        try:
            whatsapp_service.verificar_ritmo_envio(conn, empresa_id, config, telefone_destino=telefone)
            break
        except ApiError as e:
            if e.codigo == "ritmo_envio" and tentativa < 2:
                time.sleep(15)
                continue
            return False, e.mensagem
    else:
        return False, "Ritmo de envio no limite -- não deu tempo de enviar."

    try:
        contato = whatsapp_service.obter_ou_criar_contato(conn, empresa_id, telefone)
        conversa, _ = whatsapp_service.obter_ou_criar_conversa(conn, contato["id"])
        agora = whatsapp_service._now_iso()
        if envio["midia_url"]:
            url_completa = whatsapp_service.url_publica(config, envio["midia_url"])
            tipo = _classificar_tipo(envio["nome_arquivo"] or envio["midia_url"])
            externo_id = whatsapp_service.enviar_midia(
                config, telefone, tipo, url_completa, envio["nome_arquivo"], envio["texto"] or None
            )
            conn.execute(
                """INSERT INTO whatsapp_mensagens (conversa_id, direcao, tipo, texto, midia_url, nome_arquivo,
                                                    externo_id, status, criado_em, envio_massa_id)
                   VALUES (?, 'saida', ?, ?, ?, ?, ?, 'enviada', ?, ?)""",
                (conversa["id"], tipo, envio["texto"], envio["midia_url"], envio["nome_arquivo"],
                 externo_id, agora, envio["id"]),
            )
        else:
            externo_id = whatsapp_service.enviar_texto(config, telefone, envio["texto"])
            conn.execute(
                """INSERT INTO whatsapp_mensagens (conversa_id, direcao, tipo, texto, externo_id, status, criado_em, envio_massa_id)
                   VALUES (?, 'saida', 'texto', ?, ?, 'enviada', ?, ?)""",
                (conversa["id"], envio["texto"], externo_id, agora, envio["id"]),
            )
        conn.execute(
            "UPDATE whatsapp_conversas SET ultima_mensagem_em = ?, ultima_mensagem_preview = ? WHERE id = ?",
            (agora, (envio["texto"] or "📎 Anexo")[:120], conversa["id"]),
        )
        conn.execute(
            "UPDATE whatsapp_envios_massa_itens SET conversa_id = ? WHERE id = ?", (conversa["id"], item["id"])
        )
        return True, None
    except ApiError as e:
        return False, e.mensagem
    except Exception as e:
        return False, str(e)
