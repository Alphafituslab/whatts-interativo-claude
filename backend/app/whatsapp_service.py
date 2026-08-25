"""
Integração com o WhatsApp através de um serviço separado e auto-hospedado
compatível com a API REST da "Evolution API" (open-source, MIT —
https://github.com/EvolutionAPI/evolution-api), que fala o protocolo do
WhatsApp Web (biblioteca Baileys) e conecta via QR Code — não é a API
oficial da Meta (Cloud API). Ver README.md para o porquê dessa escolha e
o passo a passo de instalação.

Testado ponta-a-ponta contra uma instância real em produção (não só
smoke test simulado) — vários detalhes de contrato (formato do QR Code,
webhook, número sem o 9, limite de payload em base64 etc.) foram
ajustados a partir desses testes reais; ver histórico de commits.
"""
import base64
import csv
import datetime
import io
import json
import logging
import mimetypes
import os
import re
import secrets
import time

from .context import ApiError

TIMEOUT_PROVEDOR_SEGUNDOS = 30
PASTA_UPLOADS = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data", "uploads")

# Quanto tempo sem sinal do navegador até considerar a pessoa ausente.
# Era 3 min, mas o Windows/navegador reduz (e às vezes congela) os
# temporizadores de aba minimizada ou em segundo plano — quem só
# minimizava a janela aparecia como ausente e o cliente ouvia "não há
# ninguém disponível" com a pessoa ali do lado. Com 30 min a aba
# minimizada continua dando sinal a tempo. Sair do sistema derruba o
# status na hora (ver logout), então isto não deixa "fantasma" online.
MINUTOS_ONLINE = 30

# DDD -> UF (tabela pública da ANATEL) — usado pra descobrir de qual
# estado/região é cada contato automaticamente pelo telefone, sem
# precisar perguntar nada pra ele.
DDD_PARA_UF = {
    "11": "SP", "12": "SP", "13": "SP", "14": "SP", "15": "SP", "16": "SP", "17": "SP", "18": "SP", "19": "SP",
    "21": "RJ", "22": "RJ", "24": "RJ",
    "27": "ES", "28": "ES",
    "31": "MG", "32": "MG", "33": "MG", "34": "MG", "35": "MG", "37": "MG", "38": "MG",
    "41": "PR", "42": "PR", "43": "PR", "44": "PR", "45": "PR", "46": "PR",
    "47": "SC", "48": "SC", "49": "SC",
    "51": "RS", "53": "RS", "54": "RS", "55": "RS",
    "61": "DF",
    "62": "GO", "64": "GO",
    "63": "TO",
    "65": "MT", "66": "MT",
    "67": "MS",
    "68": "AC",
    "69": "RO",
    "71": "BA", "73": "BA", "74": "BA", "75": "BA", "77": "BA",
    "79": "SE",
    "81": "PE", "87": "PE",
    "82": "AL",
    "83": "PB",
    "84": "RN",
    "85": "CE", "88": "CE",
    "86": "PI", "89": "PI",
    "91": "PA", "93": "PA", "94": "PA",
    "92": "AM", "97": "AM",
    "95": "RR",
    "96": "AP",
    "98": "MA", "99": "MA",
}

UF_PARA_REGIAO = {
    "AC": "Norte", "AP": "Norte", "AM": "Norte", "PA": "Norte", "RO": "Norte", "RR": "Norte", "TO": "Norte",
    "AL": "Nordeste", "BA": "Nordeste", "CE": "Nordeste", "MA": "Nordeste", "PB": "Nordeste",
    "PE": "Nordeste", "PI": "Nordeste", "RN": "Nordeste", "SE": "Nordeste",
    "DF": "Centro-Oeste", "GO": "Centro-Oeste", "MT": "Centro-Oeste", "MS": "Centro-Oeste",
    "ES": "Sudeste", "MG": "Sudeste", "RJ": "Sudeste", "SP": "Sudeste",
    "PR": "Sul", "RS": "Sul", "SC": "Sul",
}


def regiao_do_telefone(telefone: str):
    """Devolve (uf, regiao) a partir do DDD de um telefone já normalizado
    (formato 55DDDNUMERO — ver normalizar_telefone). (None, None) se não
    for um número brasileiro reconhecido."""
    digitos = _somente_digitos(telefone)
    if not digitos.startswith("55") or len(digitos) < 4:
        return None, None
    ddd = digitos[2:4]
    uf = DDD_PARA_UF.get(ddd)
    if not uf:
        return None, None
    return uf, UF_PARA_REGIAO[uf]


def _now_iso():
    return datetime.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def _somente_digitos(texto):
    return re.sub(r"\D", "", texto or "")


def _extrair_base64_puro(valor):
    """A Evolution API v2 às vezes devolve base64 como um data URI
    completo ('data:image/png;base64,iVBOR...'), não só os bytes em
    base64 puro — descoberto testando o QR Code contra uma instância real
    (a documentação pública não deixava isso claro). Usado tanto pro QR
    Code quanto pra mídia recebida do cliente (mesmo formato)."""
    if not valor:
        return valor
    if valor.startswith("data:") and "base64," in valor:
        return valor.split("base64,", 1)[1]
    return valor


def eh_id_de_grupo(valor: str) -> bool:
    """Grupo do WhatsApp tem id longo e sem cara de telefone (18+
    dígitos, normalmente começando com 1203...). Telefone brasileiro
    completo tem 13. A checagem por tamanho evita confundir os dois em
    qualquer lugar que receba "o destino" sem saber o que é."""
    digitos = _somente_digitos(valor or "")
    return len(digitos) >= 15 or "@g.us" in (valor or "")


def destino_whatsapp(valor: str) -> str:
    """Endereço que a Evolution API espera. Pessoa vira número
    normalizado; grupo vai como <id>@g.us, sem passar pela normalização
    de telefone (que inseriria DDI e o 9 do celular e quebraria o id)."""
    if not valor:
        raise ApiError("Destino inválido.", status=400)
    if "@" in valor:
        return valor
    if eh_id_de_grupo(valor):
        return f"{_somente_digitos(valor)}@g.us"
    return normalizar_telefone(valor)


def normalizar_telefone(numero: str) -> str:
    """Celular brasileiro tem 9 dígitos (começando com 9) depois do DDD.
    O WhatsApp às vezes manda/aceita o número SEM esse 9 (formato antigo
    — variação real observada vinda do próprio Baileys), o que gerava
    contato duplicado (mesma pessoa virando dois cadastros diferentes) e
    fazia nosso próprio envio cair num número que na prática não existe.
    Por isso sempre normalizamos pro formato completo com o 9."""
    digitos = _somente_digitos(numero)
    if not digitos:
        raise ApiError("Telefone inválido.", status=400)
    if len(digitos) in (10, 11):
        digitos = "55" + digitos
    # 55 + DDD (2) + número sem o 9 (8) = 12 dígitos -> insere o 9.
    if len(digitos) == 12 and digitos.startswith("55"):
        digitos = digitos[:4] + "9" + digitos[4:]
    return digitos


# ============================================================
# CONFIGURAÇÃO
# ============================================================
def obter_configuracao(conn, empresa_id: int):
    row = conn.execute("SELECT * FROM configuracoes_whatsapp WHERE empresa_id = ?", (empresa_id,)).fetchone()
    if row is None:
        return {
            "id": None, "empresa_id": empresa_id, "ativo": 0, "evolution_url": None, "evolution_apikey": None,
            "instancia_nome": "whatts", "webhook_segredo": None, "webhook_base_url": None,
            "status_conexao": "desconectado", "numero_conectado": None,
            "qrcode_base64": None, "qrcode_atualizado_em": None,
            "atualizado_em": None, "atualizado_por": None,
            "expediente_ativo": 0, "expediente_janelas": None, "expediente_mensagem": None,
            "saudacao_mensagem": None,
            "sla_minutos_alerta": 15,
            "dashboard_reset_em": None,
            "logo_url": None,
        }
    return dict(row)


def config_publica(config):
    d = dict(config)
    d["apikey_configurada"] = bool(d.get("evolution_apikey"))
    d["webhook_segredo_configurado"] = bool(d.get("webhook_segredo"))
    d.pop("evolution_apikey", None)
    d.pop("webhook_segredo", None)
    d["ativo"] = bool(d.get("ativo"))
    d["expediente_ativo"] = bool(d.get("expediente_ativo"))
    d["expediente_janelas"] = json.loads(d["expediente_janelas"]) if d.get("expediente_janelas") else []
    return d


def salvar_configuracao(conn, dados, usuario_id, empresa_id: int):
    anterior = obter_configuracao(conn, empresa_id)

    # "ativo" e "expediente_ativo" são checkboxes independentes em dois
    # formulários diferentes na tela de Configuração (conexão vs.
    # expediente) — só atualiza cada um se ELE MESMO veio nesta chamada,
    # senão salvar um formulário desligaria o campo do outro sem querer.
    ativo = (1 if dados.get("ativo") else 0) if "ativo" in dados else (1 if anterior.get("ativo") else 0)
    evolution_url = (dados.get("evolution_url") or "").strip().rstrip("/") or anterior.get("evolution_url")
    instancia_nome = (dados.get("instancia_nome") or "").strip() or anterior.get("instancia_nome") or "whatts"

    if ativo and not evolution_url:
        raise ApiError("Para ativar, informe a URL do serviço Evolution API (evolution_url).", status=400)

    nova_apikey = dados.get("evolution_apikey")
    evolution_apikey = anterior.get("evolution_apikey") if not nova_apikey else nova_apikey.strip()

    novo_segredo = dados.get("webhook_segredo")
    webhook_segredo = anterior.get("webhook_segredo") if not novo_segredo else novo_segredo.strip()
    if ativo and not webhook_segredo:
        webhook_segredo = secrets.token_urlsafe(32)

    if "webhook_base_url" in dados:
        webhook_base_url = (dados.get("webhook_base_url") or "").strip().rstrip("/") or None
    else:
        webhook_base_url = anterior.get("webhook_base_url")

    expediente_ativo = (1 if dados.get("expediente_ativo") else 0) if "expediente_ativo" in dados else (1 if anterior.get("expediente_ativo") else 0)
    if "expediente_janelas" in dados:
        expediente_janelas = json.dumps(dados.get("expediente_janelas") or [])
    else:
        expediente_janelas = anterior.get("expediente_janelas")
    if "expediente_mensagem" in dados:
        expediente_mensagem = (dados.get("expediente_mensagem") or "").strip() or None
    else:
        expediente_mensagem = anterior.get("expediente_mensagem")
    sla_minutos_alerta = int(dados["sla_minutos_alerta"]) if dados.get("sla_minutos_alerta") else (anterior.get("sla_minutos_alerta") or 15)
    # Quantos minutos esperar antes de jogar na fila de todos um cliente
    # que não escolheu setor nenhum no menu.
    if dados.get("minutos_liberar_sem_menu") not in (None, ""):
        minutos_sem_menu = max(0, min(120, int(dados["minutos_liberar_sem_menu"])))
    else:
        atual = anterior.get("minutos_liberar_sem_menu")
        minutos_sem_menu = 2 if atual is None else atual
    if "saudacao_mensagem" in dados:
        saudacao_mensagem = (dados.get("saudacao_mensagem") or "").strip() or None
    else:
        saudacao_mensagem = anterior.get("saudacao_mensagem")

    conn.execute(
        """
        INSERT INTO configuracoes_whatsapp (empresa_id, ativo, evolution_url, evolution_apikey, instancia_nome,
                                              webhook_segredo, webhook_base_url, expediente_ativo, expediente_janelas,
                                              expediente_mensagem, saudacao_mensagem, sla_minutos_alerta, minutos_liberar_sem_menu, status_conexao, atualizado_em, atualizado_por)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE((SELECT status_conexao FROM configuracoes_whatsapp WHERE empresa_id = ?), 'desconectado'), ?, ?)
        ON CONFLICT(empresa_id) DO UPDATE SET
            ativo = excluded.ativo,
            evolution_url = excluded.evolution_url,
            evolution_apikey = excluded.evolution_apikey,
            instancia_nome = excluded.instancia_nome,
            webhook_segredo = excluded.webhook_segredo,
            webhook_base_url = excluded.webhook_base_url,
            expediente_ativo = excluded.expediente_ativo,
            expediente_janelas = excluded.expediente_janelas,
            expediente_mensagem = excluded.expediente_mensagem,
            saudacao_mensagem = excluded.saudacao_mensagem,
            sla_minutos_alerta = excluded.sla_minutos_alerta,
            minutos_liberar_sem_menu = excluded.minutos_liberar_sem_menu,
            atualizado_em = excluded.atualizado_em,
            atualizado_por = excluded.atualizado_por
        """,
        (empresa_id, ativo, evolution_url, evolution_apikey, instancia_nome, webhook_segredo, webhook_base_url,
         expediente_ativo, expediente_janelas, expediente_mensagem, saudacao_mensagem, sla_minutos_alerta,
         minutos_sem_menu, empresa_id, _now_iso(), usuario_id),
    )
    return obter_configuracao(conn, empresa_id)


def _atualizar_estado_conexao(conn, empresa_id: int, *, status_conexao=None, numero_conectado=None,
                               qrcode_base64=None, limpar_qrcode=False, limpar_numero=False):
    campos, valores = [], []
    if status_conexao is not None:
        campos.append("status_conexao = ?")
        valores.append(status_conexao)
    # limpar_numero existe porque numero_conectado=None significa "não
    # mexe nesse campo". Sem um jeito explícito de apagar, o número de
    # um WhatsApp que caiu ficava gravado — e o sistema seguia
    # anunciando um número que não estava mais conectado.
    if limpar_numero:
        campos.append("numero_conectado = NULL")
    elif numero_conectado is not None:
        campos.append("numero_conectado = ?")
        valores.append(numero_conectado)
    if limpar_qrcode:
        campos.append("qrcode_base64 = NULL")
    elif qrcode_base64 is not None:
        campos.append("qrcode_base64 = ?")
        valores.append(qrcode_base64)
        campos.append("qrcode_atualizado_em = ?")
        valores.append(_now_iso())
    if not campos:
        return
    valores.append(empresa_id)
    conn.execute(f"UPDATE configuracoes_whatsapp SET {', '.join(campos)} WHERE empresa_id = ?", valores)


# ============================================================
# CHAMADAS AO PROVEDOR
# ============================================================
def _requests():
    try:
        import requests
    except ImportError:
        raise ApiError(
            "A biblioteca 'requests' não está instalada — necessária para falar com o serviço da Evolution API. "
            "Rode: pip install requests",
            status=500,
        )
    return requests


def _exigir_configurado(config):
    if not config.get("evolution_url"):
        raise ApiError(
            "WhatsApp não configurado. Configure a URL do serviço Evolution API em Configurações antes de usar.",
            status=400,
        )


def _cabecalhos(config):
    return {"apikey": config.get("evolution_apikey") or "", "Content-Type": "application/json"}


def _tratar_resposta(resp):
    try:
        corpo = resp.json()
    except ValueError:
        corpo = {}
    if resp.status_code >= 500:
        raise ApiError(f"O serviço do WhatsApp está indisponível no momento (HTTP {resp.status_code}). Tente novamente em instantes.", status=502)
    if resp.status_code in (401, 403):
        raise ApiError("Chave de API do WhatsApp (Evolution API) inválida ou não configurada. Verifique em Configurações.", status=502)
    if resp.status_code >= 400:
        erro = corpo.get("message") or corpo.get("error") or f"HTTP {resp.status_code}"
        raise ApiError(f"O serviço do WhatsApp rejeitou a requisição: {erro}", status=502)
    return corpo


def conectar_instancia(conn, config, numero=None):
    """Cria (se preciso) e conecta a instância, devolvendo o QR Code (ou,
    se `numero` for informado, um código de pareamento).
    Tolerante a corrida com um "Desconectar" recente: como desconectar_
    instancia APAGA a instância inteira na Evolution API (não só
    desloga), e essa exclusão continua em segundo plano por um instante
    do lado de lá, tentar recriar/conectar logo em seguida pode falhar
    (create rejeitado porque a exclusão anterior ainda não terminou, ou
    connect devolvendo "instance does not exist") — achado testando
    contra a instância real. Por isso o ciclo create+connect inteiro é
    tentado de novo algumas vezes, com uma pausa curta entre elas, em
    vez de só um retry no passo do connect.

    Modo por número (`numero` com DDI+DDD, ex: 5511999999999): em vez de
    escanear QR Code, a Evolution API devolve um código curto pra digitar
    manualmente no WhatsApp do aparelho (Aparelhos conectados > Conectar
    com número de telefone). Só funciona se esse número já tiver uma
    conta de WhatsApp/WhatsApp Business ativa em algum aparelho — a
    Evolution API só vincula um dispositivo a uma conta existente, não
    cria conta nem ativa número novo."""
    _exigir_configurado(config)
    requests = _requests()
    instancia = config["instancia_nome"]

    qrcode_base64 = None
    codigo_pareamento = None
    for tentativa in range(5):
        try:
            requests.post(
                f"{config['evolution_url']}/instance/create",
                json={"instanceName": instancia, "qrcode": True, "integration": "WHATSAPP-BAILEYS"},
                headers=_cabecalhos(config), timeout=TIMEOUT_PROVEDOR_SEGUNDOS,
            )
        except Exception:
            pass

        try:
            resp = requests.get(
                f"{config['evolution_url']}/instance/connect/{instancia}",
                params={"number": numero} if numero else None,
                headers=_cabecalhos(config), timeout=TIMEOUT_PROVEDOR_SEGUNDOS,
            )
            corpo = _tratar_resposta(resp)
            if numero:
                # NUNCA usar corpo.get("code") aqui: é a string bruta de
                # referência do QR Code (começa com "2@...", gigante, cheia
                # de caracteres que o WhatsApp não aceita no campo de 8
                # dígitos) — não é o código de pareamento. A Evolution API
                # some tempo pra popular "pairingCode" de verdade (visto:
                # None na 1ª chamada, preenchido a partir da 2ª/3ª,
                # ~1.5-3s depois) — por isso o retry abaixo continua até
                # sair um valor de verdade, em vez de aceitar qualquer
                # resposta na primeira tentativa.
                codigo_pareamento = corpo.get("pairingCode") or None
            else:
                qrcode_base64 = _extrair_base64_puro(corpo.get("base64") or corpo.get("qrcode", {}).get("base64"))
        except ApiError:
            qrcode_base64 = None
            codigo_pareamento = None

        if qrcode_base64 or codigo_pareamento:
            break
        time.sleep(1.5)

    if qrcode_base64 or codigo_pareamento:
        # limpar_numero: a partir daqui estamos esperando um APARELHO
        # NOVO ler o código. Deixar o número anterior na tela enquanto
        # isso é enganoso — foi o que fez o sistema anunciar o número
        # velho depois de alguém parear outro aparelho.
        _atualizar_estado_conexao(conn, config["empresa_id"], status_conexao="aguardando_qrcode",
                                  qrcode_base64=qrcode_base64, limpar_numero=True)
        _registrar_webhook(config)
    return {"qrcode_base64": qrcode_base64, "codigo_pareamento": codigo_pareamento}


# Se webhook_base_url não foi configurado, usamos esse padrão: é o
# endereço pelo qual o container da Evolution API (Docker) consegue
# alcançar o Flask rodando no Windows host — validado nesta mesma
# instalação. Sem isso registrado, o envio de mensagens funciona
# normalmente, mas NADA chega de volta (nem confirmação de entrega/
# leitura, nem mensagens recebidas), porque a Evolution API não tem pra
# onde mandar os eventos.
_WEBHOOK_BASE_URL_PADRAO = "http://host.docker.internal:5050"
_WEBHOOK_EVENTOS = ["MESSAGES_UPSERT", "MESSAGES_UPDATE", "CONNECTION_UPDATE", "QRCODE_UPDATED", "PRESENCE_UPDATE"]
SEGUNDOS_DIGITANDO_WHATSAPP = 8


def url_publica(config, caminho: str) -> str:
    """Monta uma URL completa, alcançável de dentro do container da
    Evolution API, pra um caminho servido por este próprio Flask (ex.:
    /api/v1/whatsapp/uploads/xyz.pdf). Mesmo endereço-base usado pro
    webhook (ver _registrar_webhook) — já comprovado alcançável."""
    base = config.get("webhook_base_url") or _WEBHOOK_BASE_URL_PADRAO
    return f"{base}{caminho}"


def _registrar_webhook(config):
    """Registra (ou re-registra) o webhook na Evolution API. Chamado toda
    vez que conectamos, porque desconectar_instancia apaga a instância
    inteira — o que também apaga a config de webhook dela — então sem
    isso, reconectar deixava o sistema mudo pra sempre (mandava mensagem,
    mas nunca recebia nada de volta)."""
    if not config.get("webhook_segredo"):
        return
    url_webhook = url_publica(config, f"/api/v1/whatsapp/webhook/{config['webhook_segredo']}")
    try:
        requests = _requests()
        requests.post(
            f"{config['evolution_url']}/webhook/set/{config['instancia_nome']}",
            # webhookBase64=true: manda o conteúdo da mídia recebida
            # (imagem/vídeo/documento/áudio) já em base64 dentro do
            # próprio payload do webhook — sem isso só vem a URL
            # criptografada no CDN do WhatsApp, que não dá pra baixar
            # direto (precisa da chave de decriptação do protocolo Signal,
            # que só o Baileys/Evolution API tem).
            json={"webhook": {"url": url_webhook, "enabled": True, "webhookByEvents": False, "webhookBase64": True, "events": _WEBHOOK_EVENTOS}},
            headers=_cabecalhos(config), timeout=TIMEOUT_PROVEDOR_SEGUNDOS,
        )
    except Exception:
        pass


def reagir_mensagem(config, telefone: str, externo_id: str, emoji: str, minha: bool = False):
    """Cola um emoji numa mensagem, como o botão de reagir do WhatsApp.

    Emoji vazio TIRA a reação — é assim que o próprio WhatsApp faz, e
    manter a mesma regra evita precisar de uma segunda chamada só pra
    desfazer."""
    _exigir_configurado(config)
    if config.get("status_conexao") != "conectado":
        raise ApiError("O WhatsApp não está conectado no momento.", status=400)
    requests = _requests()
    resp = requests.post(
        f"{config['evolution_url']}/message/sendReaction/{config['instancia_nome']}",
        json={
            "key": {
                "remoteJid": destino_whatsapp(telefone) if "@" in destino_whatsapp(telefone)
                             else f"{destino_whatsapp(telefone)}@s.whatsapp.net",
                "fromMe": bool(minha),
                "id": externo_id,
            },
            "reaction": emoji or "",
        },
        headers=_cabecalhos(config), timeout=TIMEOUT_PROVEDOR_SEGUNDOS,
    )
    return _tratar_resposta(resp)


def criar_grupo(config, nome: str, participantes: list, descricao: str = None):
    """Cria o grupo no WhatsApp e devolve o id dele.

    Os participantes vão com o número normalizado — o WhatsApp recusa o
    grupo inteiro se um número vier num formato que ele não reconhece,
    então é melhor arrumar aqui do que descobrir pelo erro."""
    _exigir_configurado(config)
    if config.get("status_conexao") != "conectado":
        raise ApiError("O WhatsApp não está conectado — conecte um número antes de criar grupos.", status=400)
    numeros = []
    for p in participantes or []:
        try:
            numeros.append(normalizar_telefone(p))
        except ApiError:
            continue
    if not numeros:
        raise ApiError("Escolha pelo menos uma pessoa para o grupo.", status=400)
    requests = _requests()
    corpo = {"subject": nome, "participants": numeros}
    if descricao:
        corpo["description"] = descricao
    resp = requests.post(
        f"{config['evolution_url']}/group/create/{config['instancia_nome']}",
        json=corpo, headers=_cabecalhos(config), timeout=TIMEOUT_PROVEDOR_SEGUNDOS,
    )
    dados = _tratar_resposta(resp)
    jid = dados.get("id") or (dados.get("groupMetadata") or {}).get("id") or ""
    if not jid:
        raise ApiError("O WhatsApp não devolveu o identificador do grupo. Tente de novo.", status=502)
    return {"jid": jid, "id": _somente_digitos(jid), "nome": nome}


def definir_foto_grupo(config, jid: str, url_imagem: str):
    """A imagem vai por URL: a Evolution API busca o arquivo, então ele
    precisa estar num endereço que o container alcance (usamos o próprio
    site, ver url_publica). Falhar aqui não desfaz o grupo — ele já
    existe, só ficou sem foto."""
    requests = _requests()
    try:
        resp = requests.post(
            f"{config['evolution_url']}/group/updateGroupPicture/{config['instancia_nome']}",
            params={"groupJid": jid}, json={"image": url_imagem},
            headers=_cabecalhos(config), timeout=TIMEOUT_PROVEDOR_SEGUNDOS,
        )
        return resp.status_code < 400
    except Exception:
        return False


def adicionar_ao_grupo(config, jid: str, participantes: list):
    numeros = []
    for p in participantes or []:
        try:
            numeros.append(normalizar_telefone(p))
        except ApiError:
            continue
    if not numeros:
        raise ApiError("Escolha pelo menos uma pessoa.", status=400)
    requests = _requests()
    resp = requests.post(
        f"{config['evolution_url']}/group/updateParticipant/{config['instancia_nome']}",
        params={"groupJid": jid}, json={"action": "add", "participants": numeros},
        headers=_cabecalhos(config), timeout=TIMEOUT_PROVEDOR_SEGUNDOS,
    )
    return _tratar_resposta(resp)


def _numero_da_instancia(config):
    """Consulta a Evolution API pelo número de WhatsApp que está de fato
    conectado nessa instância agora — não é algo que a gente escolhe ou
    guarda no momento de conectar (o pareamento pode ter sido feito por
    QR Code ou por código, com qualquer número que tenha aceitado), então
    a única fonte confiável é perguntar pra Evolution API depois de já
    estar conectado."""
    try:
        requests = _requests()
        resp = requests.get(
            f"{config['evolution_url']}/instance/fetchInstances",
            params={"instanceName": config["instancia_nome"]},
            headers=_cabecalhos(config), timeout=TIMEOUT_PROVEDOR_SEGUNDOS,
        )
        corpo = _tratar_resposta(resp)
        instancias = corpo if isinstance(corpo, list) else [corpo]
        for inst in instancias:
            owner_jid = inst.get("ownerJid") or (inst.get("instance") or {}).get("owner")
            if owner_jid:
                return owner_jid.split("@")[0]
    except Exception:
        pass
    return None


def consultar_status(conn, config):
    _exigir_configurado(config)
    requests = _requests()
    resp = requests.get(
        f"{config['evolution_url']}/instance/connectionState/{config['instancia_nome']}",
        headers=_cabecalhos(config), timeout=TIMEOUT_PROVEDOR_SEGUNDOS,
    )
    corpo = _tratar_resposta(resp)
    estado = (corpo.get("instance") or corpo).get("state") or corpo.get("state")
    mapa = {"open": "conectado", "connecting": "aguardando_qrcode", "close": "desconectado"}
    status_conexao = mapa.get(estado, "erro")
    # O Baileys fecha e reabre o socket várias vezes ("close") enquanto o QR
    # Code ainda não foi escaneado — isso é normal durante o pareamento, não
    # uma queda de verdade. Sem essa guarda, cada consulta de status durante
    # a espera do QR rebaixava pra "desconectado" e o QR sumia da tela.
    if estado == "close" and config.get("status_conexao") == "aguardando_qrcode":
        return "aguardando_qrcode"
    # Qual número está conectado.
    #
    # Antes só perguntava "quando ainda não sabia", e o número nunca era
    # apagado ao desconectar. Resultado: quem trocava de aparelho lia o
    # QR Code com o número novo e a tela continuava mostrando o ANTIGO,
    # porque o campo estava preenchido e a consulta era pulada.
    #
    # Agora: fora do ar, o número é apagado; e a consulta é refeita
    # sempre que a conexão ACABOU de subir (o estado guardado ainda não
    # era "conectado"). Em consulta de rotina, com o estado já
    # "conectado" e o número conhecido, nada é perguntado à Evolution
    # API — que era o motivo original de pular a chamada.
    estava_conectado = config.get("status_conexao") == "conectado"
    numero_conectado, limpar_numero = None, False
    if status_conexao == "conectado":
        if not estava_conectado or not config.get("numero_conectado"):
            numero_conectado = _numero_da_instancia(config)
    else:
        limpar_numero = bool(config.get("numero_conectado"))
    _atualizar_estado_conexao(
        conn, config["empresa_id"], status_conexao=status_conexao,
        numero_conectado=numero_conectado, limpar_numero=limpar_numero,
        limpar_qrcode=(status_conexao == "conectado"),
    )
    return status_conexao


def desconectar_instancia(conn, config):
    """Sempre termina em 'desconectado' localmente, mesmo que a chamada
    à Evolution API falhe — cenário real encontrado: a sessão do
    WhatsApp já tinha caído sozinha do lado de lá (ex.: celular ficou
    muito tempo offline), então pedir 'logout' de novo dá erro
    ("instance is not connected"), mas o resultado que a gente quer
    (desconectado) já era verdade mesmo assim. Também DELETA a
    instância inteira na Evolution API (não só desloga), de propósito:
    isso limpa qualquer estado velho preso, garantindo que o próximo
    'Conectar' sempre gere um QR Code novo e funcional, em vez de
    arriscar reaproveitar uma sessão zumbi."""
    _exigir_configurado(config)
    requests = _requests()
    try:
        resp = requests.delete(
            f"{config['evolution_url']}/instance/logout/{config['instancia_nome']}",
            headers=_cabecalhos(config), timeout=TIMEOUT_PROVEDOR_SEGUNDOS,
        )
        _tratar_resposta(resp)
    except ApiError:
        pass
    try:
        requests.delete(
            f"{config['evolution_url']}/instance/delete/{config['instancia_nome']}",
            headers=_cabecalhos(config), timeout=TIMEOUT_PROVEDOR_SEGUNDOS,
        )
    except Exception:
        pass
    _atualizar_estado_conexao(conn, config["empresa_id"], status_conexao="desconectado",
                              limpar_numero=True, limpar_qrcode=True)


def ocultar_todas_conversas(conn, empresa_id: int):
    """Arquiva todas as conversas abertas — usado ao trocar de número de
    WhatsApp: some da visão normal (fila/minhas/todas), mas continua
    tudo salvo e pode ser desarquivado depois se precisar consultar."""
    conn.execute(
        """
        UPDATE whatsapp_conversas SET arquivada = 1
        WHERE arquivada = 0 AND contato_id IN (SELECT id FROM whatsapp_contatos WHERE empresa_id = ?)
        """,
        (empresa_id,),
    )


def apagar_todos_dados_clientes(conn, empresa_id: int):
    """Apaga PERMANENTEMENTE todo o histórico de clientes desta empresa
    (contatos, conversas, mensagens e tudo que depende deles) — usado ao
    trocar de número de WhatsApp quando o anterior era só teste e não
    deve deixar rastro nenhum. Não mexe em usuários/config/atividades da
    equipe (só solta a referência à conversa, que deixou de existir)."""
    conversas_ids = "SELECT c.id FROM whatsapp_conversas c JOIN whatsapp_contatos ct ON ct.id = c.contato_id WHERE ct.empresa_id = ?"
    conn.execute(f"UPDATE whatsapp_atividades SET conversa_id = NULL WHERE conversa_id IN ({conversas_ids})", (empresa_id,))
    conn.execute(f"DELETE FROM whatsapp_mensagens_agendadas WHERE conversa_id IN ({conversas_ids})", (empresa_id,))
    conn.execute(f"DELETE FROM whatsapp_lembretes WHERE conversa_id IN ({conversas_ids})", (empresa_id,))
    conn.execute(f"DELETE FROM whatsapp_atribuicoes WHERE conversa_id IN ({conversas_ids})", (empresa_id,))
    conn.execute(f"DELETE FROM whatsapp_avaliacoes WHERE conversa_id IN ({conversas_ids})", (empresa_id,))
    conn.execute(f"DELETE FROM whatsapp_notas WHERE conversa_id IN ({conversas_ids})", (empresa_id,))
    conn.execute(f"DELETE FROM whatsapp_conversa_tags WHERE conversa_id IN ({conversas_ids})", (empresa_id,))
    conn.execute(f"DELETE FROM whatsapp_mensagens WHERE conversa_id IN ({conversas_ids})", (empresa_id,))
    conn.execute(f"DELETE FROM whatsapp_conversas WHERE contato_id IN (SELECT id FROM whatsapp_contatos WHERE empresa_id = ?)", (empresa_id,))
    conn.execute("DELETE FROM whatsapp_contatos WHERE empresa_id = ?", (empresa_id,))


LIMITE_REPETICOES_MENSAGEM = 5
JANELA_REPETICAO_MINUTOS = 60


def verificar_repeticao_mensagem(conn, empresa_id: int, texto: str):
    """Proteção anti-spam: manda a MESMA mensagem, com o texto idêntico,
    repetidas vezes é exatamente o padrão que aumenta o risco de o
    número ser marcado como robô e banido pelo WhatsApp (ver aviso no
    topo do arquivo/README sobre o uso não-oficial). Depois de 5 envios
    do mesmo texto numa janela de 1 hora, bloqueia — só libera de novo
    mudando o texto ou esperando a janela passar. Contado só dentro da
    mesma empresa (o número dela é que corre risco de ban)."""
    desde = (datetime.datetime.utcnow() - datetime.timedelta(minutes=JANELA_REPETICAO_MINUTOS)).strftime("%Y-%m-%dT%H:%M:%S.%fZ")
    linha = conn.execute(
        """
        SELECT COUNT(*) AS n FROM whatsapp_mensagens m
        JOIN whatsapp_conversas c ON c.id = m.conversa_id
        JOIN whatsapp_contatos ct ON ct.id = c.contato_id
        WHERE m.direcao = 'saida' AND m.tipo = 'texto' AND m.texto = ? AND m.criado_em >= ? AND ct.empresa_id = ?
        """,
        (texto, desde, empresa_id),
    ).fetchone()
    if linha["n"] >= LIMITE_REPETICOES_MENSAGEM:
        raise ApiError(
            f"Essa mesma mensagem já foi enviada {LIMITE_REPETICOES_MENSAGEM} vezes na última hora. "
            "Mude o texto ou espere cerca de 1 hora antes de enviar de novo — isso evita que o número "
            "seja identificado como robô pelo WhatsApp.",
            status=429, codigo="mensagem_repetida",
        )


def enviar_texto(config, telefone: str, texto: str, citar_externo_id: str = None) -> str:
    """citar_externo_id: id da mensagem que está sendo respondida. Vai no
    campo `quoted` da Evolution API pra que, no celular do cliente, a
    resposta apareça grudada na mensagem certa — do mesmo jeito que
    acontece quando ele responde pelo WhatsApp dele."""
    _exigir_configurado(config)
    if config.get("status_conexao") != "conectado":
        raise ApiError("O WhatsApp não está conectado no momento. Peça a um administrador para reconectar em Configurações.", status=400)
    requests = _requests()
    corpo_envio = {"number": destino_whatsapp(telefone), "text": texto}
    if citar_externo_id:
        corpo_envio["quoted"] = {"key": {"id": citar_externo_id}}
    resp = requests.post(
        f"{config['evolution_url']}/message/sendText/{config['instancia_nome']}",
        json=corpo_envio,
        headers=_cabecalhos(config), timeout=TIMEOUT_PROVEDOR_SEGUNDOS,
    )
    corpo = _tratar_resposta(resp)
    chave = corpo.get("key") or {}
    return chave.get("id")


MAPA_TIPO_MEDIA_EVOLUTION = {"imagem": "image", "video": "video", "documento": "document", "audio": "audio", "figurinha": "image"}


def enviar_figurinha(config, telefone: str, midia_url: str) -> str:
    """Figurinha tem rota própria na Evolution API. Mandar pelo sendMedia
    faria ela chegar como imagem comum (com fundo e moldura de foto) em
    vez de figurinha de verdade. Mesmo esquema do enviar_midia: manda a
    URL e a Evolution API busca o arquivo sozinha."""
    _exigir_configurado(config)
    if config.get("status_conexao") != "conectado":
        raise ApiError("O WhatsApp não está conectado no momento. Peça a um administrador para reconectar em Configurações.", status=400)
    requests = _requests()
    resp = requests.post(
        f"{config['evolution_url']}/message/sendSticker/{config['instancia_nome']}",
        json={"number": destino_whatsapp(telefone), "sticker": midia_url},
        headers=_cabecalhos(config), timeout=120,
    )
    corpo = _tratar_resposta(resp)
    return (corpo.get("key") or {}).get("id")


def enviar_midia(config, telefone: str, tipo: str, midia_url: str, nome_arquivo: str, legenda: str = None) -> str:
    """Envia uma mídia (imagem/vídeo/documento/áudio) passando uma URL
    (não o conteúdo em base64 embutido no corpo da requisição) — a
    Evolution API busca o arquivo ela mesma nessa URL. Descoberto
    testando contra a instância real: anexos grandes em base64 (o JSON
    fica ~33% maior que o arquivo original) estouravam algum limite
    interno da Evolution API e voltavam HTTP 500 mesmo dentro do nosso
    próprio limite de tamanho; por URL a Evolution API baixa o arquivo
    direto, sem esse problema. midia_url precisa ser uma URL completa,
    alcançável de dentro do container da Evolution API (ver url_publica)."""
    _exigir_configurado(config)
    if config.get("status_conexao") != "conectado":
        raise ApiError("O WhatsApp não está conectado no momento. Peça a um administrador para reconectar em Configurações.", status=400)
    requests = _requests()
    resp = requests.post(
        f"{config['evolution_url']}/message/sendMedia/{config['instancia_nome']}",
        json={
            "number": destino_whatsapp(telefone),
            "mediatype": MAPA_TIPO_MEDIA_EVOLUTION.get(tipo, "document"),
            "media": midia_url,
            "fileName": nome_arquivo,
            "caption": legenda or "",
        },
        headers=_cabecalhos(config), timeout=120,
    )
    corpo = _tratar_resposta(resp)
    chave = corpo.get("key") or {}
    return chave.get("id")


# ============================================================
# RESUMO DA CONVERSA
# ============================================================
def salvar_resumo(conn, conversa_id: int, resumo: str):
    conn.execute("UPDATE whatsapp_conversas SET resumo = ? WHERE id = ?", (resumo, conversa_id))


# ============================================================
# MENSAGENS AGENDADAS — o envio de verdade acontece em app/scheduler.py
# (thread em segundo plano), reaproveitando enviar_texto acima.
# ============================================================
def agendar_mensagem(conn, conversa_id: int, texto: str, agendado_para: str, criado_por: int,
                      tipo: str = "texto", midia_url: str = None, nome_arquivo: str = None):
    cur = conn.execute(
        """
        INSERT INTO whatsapp_mensagens_agendadas
            (conversa_id, texto, agendado_para, criado_por, criado_em, tipo, midia_url, nome_arquivo)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (conversa_id, texto, agendado_para, criado_por, _now_iso(), tipo, midia_url, nome_arquivo),
    )
    return dict(conn.execute("SELECT * FROM whatsapp_mensagens_agendadas WHERE id = ?", (cur.lastrowid,)).fetchone())


def listar_agendadas(conn, conversa_id: int):
    rows = conn.execute(
        "SELECT * FROM whatsapp_mensagens_agendadas WHERE conversa_id = ? AND status = 'pendente' ORDER BY agendado_para",
        (conversa_id,),
    ).fetchall()
    return [dict(r) for r in rows]


def listar_todas_agendadas(conn, empresa_id: int, usuario_id=None):
    """Visão global (tela "Agendamentos"), diferente de listar_agendadas
    (que é só de UMA conversa, usada dentro do chat). usuario_id=None
    (só admin deveria pedir isso) devolve as de todo mundo NA EMPRESA —
    mesma régua de 'admin vê tudo' já usada em listar_lembretes."""
    base = """
        SELECT a.*, ct.nome AS contato_nome, ct.telefone, u.nome AS criado_por_nome,
               CASE WHEN a.chat_interno_conversa_id IS NOT NULL THEN 'interno' ELSE 'cliente' END AS origem,
               uc.nome AS interna_criador, up.nome AS interna_participante,
               ci.criado_por_id AS interna_criador_id, ci.participante_id AS interna_participante_id
        FROM whatsapp_mensagens_agendadas a
        LEFT JOIN whatsapp_conversas c ON c.id = a.conversa_id
        LEFT JOIN whatsapp_contatos ct ON ct.id = c.contato_id
        LEFT JOIN chat_interno_conversas ci ON ci.id = a.chat_interno_conversa_id
        LEFT JOIN usuarios uc ON uc.id = ci.criado_por_id
        LEFT JOIN usuarios up ON up.id = ci.participante_id
        JOIN usuarios u ON u.id = a.criado_por
        WHERE a.status = 'pendente' AND (ct.empresa_id = ? OR (ci.id IS NOT NULL AND u.empresa_id = ?))
    """
    if usuario_id is not None:
        rows = conn.execute(base + " AND a.criado_por = ? ORDER BY a.agendado_para", (empresa_id, empresa_id, usuario_id)).fetchall()
    else:
        rows = conn.execute(base + " ORDER BY a.agendado_para", (empresa_id, empresa_id)).fetchall()
    return [dict(r) for r in rows]


def cancelar_agendada(conn, agendada_id: int):
    conn.execute(
        "UPDATE whatsapp_mensagens_agendadas SET status = 'cancelada' WHERE id = ? AND status = 'pendente'",
        (agendada_id,),
    )


def processar_agendadas_vencidas(conn):
    """Chamado periodicamente pelo agendador em segundo plano (app/
    scheduler.py). Cada mensagem vencida vira uma mensagem 'saida' de
    verdade — mesmo caminho do envio manual (enviar_texto), então elas
    aparecem na conversa e contam nas métricas do dashboard normalmente.
    """
    agora = _now_iso()
    vencidas = conn.execute(
        "SELECT * FROM whatsapp_mensagens_agendadas WHERE status = 'pendente' AND agendado_para <= ?",
        (agora,),
    ).fetchall()
    if not vencidas:
        return 0

    processadas = 0
    for agendada in vencidas:
        # Mensagem agendada pro CHAT INTERNO: entrega direto no banco,
        # sem passar pela Evolution API. De propósito — o chat interno
        # tem que funcionar mesmo com o WhatsApp desconectado.
        interna_id = agendada["chat_interno_conversa_id"] if "chat_interno_conversa_id" in agendada.keys() else None
        if interna_id:
            from . import chat_interno_service
            existe = conn.execute("SELECT 1 FROM chat_interno_conversas WHERE id = ?", (interna_id,)).fetchone()
            if existe is None:
                conn.execute("UPDATE whatsapp_mensagens_agendadas SET status = 'falhou', erro = ? WHERE id = ?",
                             ("Conversa interna não existe mais.", agendada["id"]))
            else:
                chat_interno_service.enviar_mensagem(
                    conn, interna_id, agendada["criado_por"], agendada["texto"],
                    tipo=agendada["tipo"] if "tipo" in agendada.keys() else "texto",
                    midia_url=agendada["midia_url"] if "midia_url" in agendada.keys() else None,
                    nome_arquivo=agendada["nome_arquivo"] if "nome_arquivo" in agendada.keys() else None,
                )
                conn.execute("UPDATE whatsapp_mensagens_agendadas SET status = 'enviada' WHERE id = ?", (agendada["id"],))
            processadas += 1
            continue

        # Cada conversa pode ser de uma empresa diferente (o agendador
        # roda uma vez só pra todo mundo em segundo plano) — resolve a
        # config (URL/apikey da Evolution API) certa por empresa aqui
        # dentro do loop, nunca uma config fixa reaproveitada pra todas.
        conversa = conn.execute(
            "SELECT c.*, ct.telefone, ct.empresa_id FROM whatsapp_conversas c JOIN whatsapp_contatos ct ON ct.id = c.contato_id WHERE c.id = ?",
            (agendada["conversa_id"],),
        ).fetchone()
        if conversa is None:
            conn.execute("UPDATE whatsapp_mensagens_agendadas SET status = 'falhou', erro = ? WHERE id = ?",
                         ("Conversa não existe mais.", agendada["id"]))
            processadas += 1
            continue
        config = obter_configuracao(conn, conversa["empresa_id"])
        # Mesmo padrão do envio manual (routes/whatsapp.py::enviar_mensagem):
        # a mensagem é sempre registrada na conversa, enviada ou não — se
        # falhar, o operador vê o aviso (⚠️) na própria conversa depois,
        # em vez de a mensagem simplesmente sumir sem explicação.
        tipo_agendada = agendada["tipo"] if "tipo" in agendada.keys() else "texto"
        midia_url_agendada = agendada["midia_url"] if "midia_url" in agendada.keys() else None
        try:
            if midia_url_agendada:
                url_completa = url_publica(config, midia_url_agendada)
                nome_arq = agendada["nome_arquivo"] if "nome_arquivo" in agendada.keys() else None
                externo_id = enviar_midia(config, conversa["telefone"], tipo_agendada, url_completa, nome_arq, agendada["texto"])
            else:
                externo_id = enviar_texto(config, conversa["telefone"], agendada["texto"])
            status_msg, erro = "enviada", None
        except ApiError as e:
            externo_id, status_msg, erro = None, "falhou", e.mensagem

        agora = _now_iso()
        conn.execute(
            """
            INSERT INTO whatsapp_mensagens (conversa_id, direcao, tipo, texto, midia_url, externo_id, usuario_id, status, erro, criado_em)
            VALUES (?, 'saida', ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (conversa["id"], tipo_agendada, agendada["texto"], midia_url_agendada, externo_id, agendada["criado_por"], status_msg, erro, agora),
        )
        conn.execute(
            "UPDATE whatsapp_conversas SET status = 'aberta', fechada_em = NULL, ultima_mensagem_em = ?, ultima_mensagem_preview = ? WHERE id = ?",
            (agora, agendada["texto"][:120], conversa["id"]),
        )
        conn.execute("UPDATE whatsapp_mensagens_agendadas SET status = ?, erro = ? WHERE id = ?", (status_msg, erro, agendada["id"]))
        processadas += 1
    return processadas


# ============================================================
# LEMBRETES DE RETORNO
# ============================================================
def criar_lembrete(conn, conversa_id: int, usuario_id: int, texto: str, lembrar_em: str, criado_por: int):
    cur = conn.execute(
        """
        INSERT INTO whatsapp_lembretes (conversa_id, usuario_id, texto, lembrar_em, criado_por, criado_em)
        VALUES (?, ?, ?, ?, ?, ?)
        """,
        (conversa_id, usuario_id, texto, lembrar_em, criado_por, _now_iso()),
    )
    return dict(conn.execute("SELECT * FROM whatsapp_lembretes WHERE id = ?", (cur.lastrowid,)).fetchone())


def listar_lembretes(conn, empresa_id: int, usuario_id=None):
    """usuario_id=None (só admin deveria pedir isso) devolve os lembretes
    de TODO MUNDO NA EMPRESA — mesma régua de 'admin vê tudo' do resto do sistema."""
    # LEFT JOIN nos dois lados: o lembrete aponta pra uma conversa de
    # cliente OU pra uma interna, nunca as duas. Com JOIN comum, os
    # internos sumiriam da lista.
    base = """
        SELECT l.*, c.contato_id, ct.nome AS contato_nome, ct.telefone, u.nome AS usuario_nome,
               ci.id AS interna_id,
               CASE WHEN l.chat_interno_conversa_id IS NOT NULL THEN 'interno' ELSE 'cliente' END AS origem,
               uc.nome AS interna_criador, up.nome AS interna_participante,
               ci.criado_por_id AS interna_criador_id, ci.participante_id AS interna_participante_id
        FROM whatsapp_lembretes l
        LEFT JOIN whatsapp_conversas c ON c.id = l.conversa_id
        LEFT JOIN whatsapp_contatos ct ON ct.id = c.contato_id
        LEFT JOIN chat_interno_conversas ci ON ci.id = l.chat_interno_conversa_id
        LEFT JOIN usuarios uc ON uc.id = ci.criado_por_id
        LEFT JOIN usuarios up ON up.id = ci.participante_id
        JOIN usuarios u ON u.id = l.usuario_id
        WHERE l.concluido = 0 AND (ct.empresa_id = ? OR (ci.id IS NOT NULL AND u.empresa_id = ?))
    """
    if usuario_id is not None:
        rows = conn.execute(base + " AND l.usuario_id = ? ORDER BY l.lembrar_em", (empresa_id, empresa_id, usuario_id)).fetchall()
    else:
        rows = conn.execute(base + " ORDER BY l.lembrar_em", (empresa_id, empresa_id)).fetchall()
    return [dict(r) for r in rows]


def concluir_lembrete(conn, lembrete_id: int):
    conn.execute("UPDATE whatsapp_lembretes SET concluido = 1 WHERE id = ?", (lembrete_id,))


# ============================================================
# EXCLUIR MENSAGEM (ex.: mandada pro cliente errado por engano)
# ============================================================
def excluir_mensagem(conn, config, mensagem: dict, excluida_por: int = None) -> bool:
    """Some da nossa conversa sempre (exclusão local garantida). Também
    TENTA apagar do lado do WhatsApp ("apagar para todos" via a Evolution
    API) — mas isso só funciona mesmo se o WhatsApp ainda permitir (janela
    de tempo curta desde o envio, controlada pelo próprio WhatsApp, que a
    API não-oficial não consegue burlar); se der errado ou a mensagem já
    estiver fora da janela, a mensagem simplesmente continua visível pro
    cliente do lado dele, mas some da nossa tela de qualquer forma."""
    apagada_no_whatsapp = False
    if mensagem.get("externo_id") and config.get("status_conexao") == "conectado":
        try:
            requests = _requests()
            conversa = conn.execute(
                "SELECT ct.telefone FROM whatsapp_conversas c JOIN whatsapp_contatos ct ON ct.id = c.contato_id WHERE c.id = ?",
                (mensagem["conversa_id"],),
            ).fetchone()
            if conversa:
                resp = requests.delete(
                    f"{config['evolution_url']}/chat/deleteMessageForEveryone/{config['instancia_nome']}",
                    json={
                        "id": mensagem["externo_id"],
                        "remoteJid": f"{conversa['telefone']}@s.whatsapp.net",
                        "fromMe": True,
                    },
                    headers=_cabecalhos(config), timeout=TIMEOUT_PROVEDOR_SEGUNDOS,
                )
                apagada_no_whatsapp = resp.status_code < 400
        except Exception:
            pass
    conn.execute("UPDATE whatsapp_mensagens SET excluida_em = ?, excluida_por = ? WHERE id = ?", (_now_iso(), excluida_por, mensagem["id"]))
    return apagada_no_whatsapp


def reenviar_mensagem(conn, config, mensagem: dict) -> bool:
    """Tenta reenviar uma mensagem que falhou (texto ou mídia) sem
    precisar escrever/anexar de novo — reaproveita o texto ou o arquivo
    já salvo. Atualiza a mensagem original em vez de criar uma nova
    (continua na mesma posição na conversa)."""
    conversa = conn.execute(
        "SELECT ct.telefone FROM whatsapp_conversas c JOIN whatsapp_contatos ct ON ct.id = c.contato_id WHERE c.id = ?",
        (mensagem["conversa_id"],),
    ).fetchone()
    if not conversa:
        raise ApiError("Conversa não encontrada.", status=404, codigo="nao_encontrado")
    try:
        if mensagem["tipo"] == "texto":
            externo_id = enviar_texto(config, conversa["telefone"], mensagem["texto"] or "")
        else:
            url_completa = url_publica(config, mensagem["midia_url"])
            nome_arquivo = mensagem["midia_url"].rsplit("/", 1)[-1].split("_", 1)[-1]
            externo_id = enviar_midia(config, conversa["telefone"], mensagem["tipo"], url_completa, nome_arquivo, mensagem["texto"] or None)
        conn.execute("UPDATE whatsapp_mensagens SET status = 'enviada', erro = NULL, externo_id = ? WHERE id = ?", (externo_id, mensagem["id"]))
        return True
    except ApiError as e:
        conn.execute("UPDATE whatsapp_mensagens SET status = 'falhou', erro = ? WHERE id = ?", (e.mensagem, mensagem["id"]))
        return False


# ============================================================
# ARQUIVAR / EXCLUIR CONVERSA
# ============================================================
def arquivar_conversa(conn, conversa_id: int, arquivar: bool):
    conn.execute("UPDATE whatsapp_conversas SET arquivada = ? WHERE id = ?", (1 if arquivar else 0, conversa_id))


def excluir_conversa(conn, conversa_id: int):
    """Exclusão lógica: some de todas as listas do sistema pra todo mundo
    (fila, minhas, todas, arquivadas). Isso NÃO apaga a conversa do
    WhatsApp de verdade — não existe essa opção via API não-oficial pra
    uma conversa inteira (só mensagem por mensagem, e só dentro da janela
    de tempo que o próprio WhatsApp permite). Os dados continuam no banco
    (não removidos fisicamente), preservando o histórico para auditoria."""
    conn.execute("UPDATE whatsapp_conversas SET excluida_em = ? WHERE id = ?", (_now_iso(), conversa_id))


# ============================================================
# RASTRO DE ATIVIDADES — visão do administrador
# ============================================================
def registrar_atividade(conn, usuario_id, tipo: str, descricao: str = None, conversa_id: int = None):
    conn.execute(
        "INSERT INTO whatsapp_atividades (usuario_id, tipo, descricao, conversa_id, criado_em) VALUES (?, ?, ?, ?, ?)",
        (usuario_id, tipo, descricao, conversa_id, _now_iso()),
    )


def listar_atividades(conn, empresa_id: int, usuario_id: int = None, limite: int = 300):
    query = """
        SELECT a.*, u.nome AS usuario_nome, u.email AS usuario_email
        FROM whatsapp_atividades a
        JOIN usuarios u ON u.id = a.usuario_id
        WHERE u.empresa_id = ?
    """
    params = [empresa_id]
    if usuario_id:
        query += " AND a.usuario_id = ?"
        params.append(usuario_id)
    query += " ORDER BY a.criado_em DESC LIMIT ?"
    params.append(limite)
    return [dict(r) for r in conn.execute(query, params).fetchall()]


# ============================================================
# WEBHOOK DE ENTRADA
# ============================================================
def processar_evento_webhook(conn, config, payload: dict):
    """config já vem resolvido pelo chamador (routes/whatsapp.py), pela
    empresa dona do webhook_segredo que veio na URL — cada empresa tem o
    seu, então é assim que a mensagem chega pra empresa certa."""
    evento = (payload.get("event") or "").lower()

    if evento in ("connection.update", "connection_update"):
        dados = payload.get("data") or {}
        estado = dados.get("state")
        mapa = {"open": "conectado", "connecting": "aguardando_qrcode", "close": "desconectado"}
        # Mesma ressalva de consultar_status: "close" é normal enquanto o
        # QR Code ainda não foi escaneado (o Baileys reabre o socket a cada
        # ciclo de QR), não uma desconexão de verdade.
        if estado in mapa:
            novo_status = mapa[estado]
            if estado == "close" and config.get("status_conexao") == "aguardando_qrcode":
                return {"processado": True, "tipo": "conexao"}
            _atualizar_estado_conexao(conn, config["empresa_id"], status_conexao=novo_status, limpar_qrcode=(novo_status == "conectado"))
        return {"processado": True, "tipo": "conexao"}

    if evento in ("qrcode.updated", "qrcode_updated"):
        dados = payload.get("data") or {}
        qrcode_base64 = dados.get("qrcode", {}).get("base64") if isinstance(dados.get("qrcode"), dict) else dados.get("base64")
        qrcode_base64 = _extrair_base64_puro(qrcode_base64)
        if qrcode_base64:
            _atualizar_estado_conexao(conn, config["empresa_id"], status_conexao="aguardando_qrcode", qrcode_base64=qrcode_base64)
        return {"processado": True, "tipo": "qrcode"}

    if evento in ("messages.upsert", "messages_upsert"):
        return _processar_mensagem_recebida(conn, config, payload.get("data") or {})

    if evento in ("messages.update", "messages_update"):
        return _processar_status_mensagem(conn, config["empresa_id"], payload.get("data"))

    if evento in ("presence.update", "presence_update"):
        # "Digitando…" do lado do cliente. Formato do payload não é
        # 100% garantido (não documentado claramente pela Evolution API
        # nesta versão) — tenta os campos mais prováveis e ignora em
        # silêncio se não bater; não é uma função crítica.
        try:
            _processar_presenca(conn, config["empresa_id"], payload.get("data") or {})
        except Exception:
            pass
        return {"processado": True, "tipo": "presenca"}

    return {"processado": False, "tipo": evento or "desconhecido"}


def _processar_presenca(conn, empresa_id: int, dados: dict):
    remote_jid = dados.get("id") or dados.get("remoteJid") or ""
    telefone_bruto = remote_jid.split("@")[0].split(":")[0]
    if not telefone_bruto:
        return
    presencas = dados.get("presences") or {}
    valores = presencas.values() if isinstance(presencas, dict) else []
    digitando = any((p or {}).get("lastKnownPresence") in ("composing", "recording") for p in valores) \
        or dados.get("lastKnownPresence") in ("composing", "recording")
    if not digitando:
        return
    try:
        telefone = normalizar_telefone(telefone_bruto)
    except ApiError:
        telefone = telefone_bruto
    ate = (datetime.datetime.utcnow() + datetime.timedelta(seconds=SEGUNDOS_DIGITANDO_WHATSAPP)).strftime("%Y-%m-%dT%H:%M:%S.%fZ")
    conn.execute(
        """
        UPDATE whatsapp_conversas SET digitando_ate = ?
        WHERE contato_id = (SELECT id FROM whatsapp_contatos WHERE empresa_id = ? AND telefone = ?)
        """,
        (ate, empresa_id, telefone),
    )


# Baileys manda o "ack" da mensagem (enviada/entregue/lida) tanto como
# número (WAMessageStatus) quanto como nome, dependendo da versão —
# tratamos os dois. Só avançamos o status (nunca regredimos por causa de
# um ack atrasado chegando fora de ordem).
_MAPA_STATUS_MENSAGEM = {
    "2": "enviada", "SERVER_ACK": "enviada",
    "3": "entregue", "DELIVERY_ACK": "entregue",
    "4": "lida", "READ": "lida",
    "5": "lida", "PLAYED": "lida",
}
_RANQUE_STATUS_MENSAGEM = {"pendente": 0, "enviada": 1, "entregue": 2, "lida": 3, "falhou": 0, "recebida": 0}


def _processar_status_mensagem(conn, empresa_id: int, dados):
    itens = dados if isinstance(dados, list) else [dados or {}]
    atualizados = 0
    for item in itens:
        item = item or {}
        externo_id = item.get("keyId") or (item.get("key") or {}).get("id")
        valor_status = item.get("status")
        if valor_status is None:
            valor_status = (item.get("update") or {}).get("status")
        novo_status = _MAPA_STATUS_MENSAGEM.get(str(valor_status))
        if not externo_id or not novo_status:
            continue
        # Junta até whatsapp_contatos pra garantir que só mexe em mensagem
        # de dentro da empresa dona deste webhook — externo_id sozinho não
        # tem garantia de ser único ENTRE empresas (cada uma tem sua
        # própria instância Evolution API gerando esses IDs).
        linha = conn.execute(
            """
            SELECT m.status FROM whatsapp_mensagens m
            JOIN whatsapp_conversas c ON c.id = m.conversa_id
            JOIN whatsapp_contatos ct ON ct.id = c.contato_id
            WHERE m.externo_id = ? AND m.direcao = 'saida' AND ct.empresa_id = ?
            """,
            (externo_id, empresa_id),
        ).fetchone()
        if not linha:
            continue
        if _RANQUE_STATUS_MENSAGEM.get(novo_status, 0) <= _RANQUE_STATUS_MENSAGEM.get(linha["status"], 0):
            continue
        conn.execute("UPDATE whatsapp_mensagens SET status = ? WHERE externo_id = ?", (novo_status, externo_id))
        atualizados += 1
    return {"processado": True, "tipo": "status_mensagem", "quantidade": atualizados}


def _autor_da_mensagem_de_grupo(dados: dict, chave: dict):
    """Quem falou, numa mensagem de grupo.

    A Evolution API não põe isso sempre no mesmo lugar — muda com a
    versão e com o tipo da mensagem. Em vez de apostar num campo só (o
    que deixava toda fala do grupo sem dono), procura em todos os lugares
    conhecidos, na ordem do mais específico pro mais genérico.

    Se não achar em nenhum, registra o formato recebido no log: é a
    única forma de descobrir um campo novo sem ficar adivinhando.
    """
    candidatos = [
        chave.get("participant"),
        chave.get("participantPn"),
        chave.get("participantAlt"),
        dados.get("participant"),
        dados.get("participantPn"),
        (dados.get("message") or {}).get("participant"),
        ((dados.get("message") or {}).get("extendedTextMessage") or {})
            .get("contextInfo", {}).get("participant"),
        (dados.get("contextInfo") or {}).get("participant"),
        (dados.get("key") or {}).get("senderPn"),
        dados.get("senderPn"),
        dados.get("sender"),
    ]
    bruto = ""
    for c in candidatos:
        if isinstance(c, str) and c.strip():
            bruto = c.split("@")[0].split(":")[0].strip()
            if bruto:
                break

    telefone = None
    if bruto:
        try:
            telefone = normalizar_telefone(bruto)
        except ApiError:
            telefone = bruto

    # pushName, num grupo, é o nome de quem FALOU (não o do grupo).
    nome = dados.get("pushName") or dados.get("notifyName") or dados.get("verifiedBizName") or None

    if not telefone and not nome:
        try:
            import json as _json
            logging.getLogger(__name__).warning(
                "Mensagem de grupo sem autor identificado. Campos recebidos: %s",
                _json.dumps({k: v for k, v in dados.items() if k != "message"}, ensure_ascii=False)[:900],
            )
        except Exception:
            pass
    return nome, telefone


def _extrair_reacao(dados: dict):
    """Devolve (id_da_mensagem_reagida, emoji) quando o que chegou é uma
    reação, ou None.

    Reação é o emoji que a pessoa cola numa mensagem já existente. Ela
    chega pelo mesmo evento das mensagens normais, mas não tem texto nem
    mídia — era por isso que virava uma bolha em branco na conversa.
    Emoji vazio significa que a pessoa REMOVEU a reação."""
    conteudo = (dados.get("message") or {})
    reacao = conteudo.get("reactionMessage")
    if not isinstance(reacao, dict):
        return None
    alvo = (reacao.get("key") or {}).get("id")
    if not alvo:
        return None
    return alvo, (reacao.get("text") or "")


def _aplicar_reacao(conn, empresa_id: int, id_alvo: str, emoji: str):
    """Cola (ou tira) a reação na mensagem que ela aponta. Se a mensagem
    reagida não está aqui — o cliente pode reagir a algo muito antigo —,
    simplesmente ignora: melhor não registrar nada do que inventar uma
    mensagem só pra pendurar um emoji."""
    linha = conn.execute(
        "SELECT m.id FROM whatsapp_mensagens m "
        "JOIN whatsapp_conversas c ON c.id = m.conversa_id "
        "JOIN whatsapp_contatos ct ON ct.id = c.contato_id "
        "WHERE m.externo_id = ? AND ct.empresa_id = ?",
        (id_alvo, empresa_id),
    ).fetchone()
    if linha is None:
        return False
    conn.execute(
        "UPDATE whatsapp_mensagens SET reacao = ?, reacao_em = ? WHERE id = ?",
        (emoji or None, _now_iso() if emoji else None, linha["id"]),
    )
    return True


def _extrair_texto(mensagem: dict) -> str:
    conteudo = mensagem.get("message") or {}
    return (
        conteudo.get("conversation")
        or (conteudo.get("extendedTextMessage") or {}).get("text")
        or (conteudo.get("imageMessage") or {}).get("caption")
        or (conteudo.get("videoMessage") or {}).get("caption")
        or (conteudo.get("documentMessage") or {}).get("caption")
        or ""
    )


_CAMPOS_MIDIA_WHATSAPP = {
    "imageMessage": "imagem",
    "videoMessage": "video",
    "documentMessage": "documento",
    "audioMessage": "audio",
    # Sem isto a figurinha recebida sumia: nao batia com nenhum tipo
    # conhecido, entao a mensagem entrava vazia, sem imagem nenhuma.
    "stickerMessage": "figurinha",
}


def _baixar_midia_via_api(config, externo_id: str, remote_jid: str):
    """Baixa o conteúdo real (já decriptado) de uma mídia recebida usando
    o endpoint dedicado da Evolution API. Necessário porque o webhook por
    si só só manda a URL criptografada no CDN do WhatsApp — testado
    contra a instância real: ligar 'webhookBase64=true' (ver
    _registrar_webhook) NÃO fez efeito nesta versão (payload continuou
    só com a URL), então buscamos por fora, sob demanda, para cada mídia
    recebida, em vez de depender da config do webhook."""
    try:
        requests = _requests()
        resp = requests.post(
            f"{config['evolution_url']}/chat/getBase64FromMediaMessage/{config['instancia_nome']}",
            json={"message": {"key": {"id": externo_id, "remoteJid": remote_jid, "fromMe": False}}},
            headers=_cabecalhos(config), timeout=60,
        )
        corpo = _tratar_resposta(resp)
        return corpo.get("base64") or (corpo.get("media") or {}).get("base64")
    except Exception:
        return None


def _extrair_midia(dados: dict, config=None, remote_jid: str = None, externo_id: str = None):
    """Se a mensagem recebida for imagem/vídeo/documento/áudio, devolve
    (tipo, base64_dados, nome_arquivo); senão devolve None (mensagem só
    de texto). Tenta primeiro achar o base64 já embutido no payload (caso
    alguma versão da Evolution API mande assim); se não achar e tiver
    'config' + 'externo_id', busca por fora via _baixar_midia_via_api."""
    conteudo = dados.get("message") or {}
    # Documento COM legenda vem aninhado numa estrutura diferente
    # (documentWithCaptionMessage.message.documentMessage), variante mais
    # nova do protocolo do WhatsApp.
    aninhado = (conteudo.get("documentWithCaptionMessage") or {}).get("message") or {}

    for campo, tipo in _CAMPOS_MIDIA_WHATSAPP.items():
        info = conteudo.get(campo) or aninhado.get(campo)
        if not info:
            continue
        base64_dados = info.get("base64") or dados.get("base64") or dados.get("messageBase64") or conteudo.get("base64")
        if not base64_dados and config and externo_id:
            base64_dados = _baixar_midia_via_api(config, externo_id, remote_jid)
        if not base64_dados:
            _registrar_payload_midia_sem_base64(dados)
            return None
        mimetype = (info.get("mimetype") or "application/octet-stream").split(";")[0].strip()
        extensao = mimetypes.guess_extension(mimetype) or ""
        nome_arquivo = info.get("fileName") or f"{tipo}{extensao}"
        return tipo, base64_dados, nome_arquivo
    return None


def _registrar_payload_midia_sem_base64(dados: dict):
    """Diagnóstico temporário: se detectamos uma mídia mas não achamos o
    base64 em nenhum dos campos esperados, grava o payload cru num
    arquivo — assim dá pra ver o formato exato que esta versão da
    Evolution API está mandando e ajustar _extrair_midia rapidinho, sem
    ficar adivinhando. Best-effort: nunca deixa isso quebrar o
    processamento da mensagem."""
    try:
        pasta = os.path.join(os.path.dirname(PASTA_UPLOADS), "debug")
        os.makedirs(pasta, exist_ok=True)
        with open(os.path.join(pasta, "midia_sem_base64.log"), "a", encoding="utf-8") as f:
            f.write(_now_iso() + " " + json.dumps(dados, ensure_ascii=False)[:5000] + "\n")
    except Exception:
        pass


def _salvar_midia_recebida(base64_dados: str, nome_arquivo: str) -> str:
    base64_dados = _extrair_base64_puro(base64_dados)
    os.makedirs(PASTA_UPLOADS, exist_ok=True)
    nome_seguro = f"{secrets.token_hex(8)}_{re.sub(r'[^A-Za-z0-9._-]', '_', nome_arquivo)}"
    with open(os.path.join(PASTA_UPLOADS, nome_seguro), "wb") as f:
        f.write(base64.b64decode(base64_dados))
    return f"/api/v1/whatsapp/uploads/{nome_seguro}"


def buscar_foto_perfil_contato(config, telefone: str):
    """Busca a URL da foto de perfil do WhatsApp do contato. Nem todo
    contato tem foto pública (privacidade dele) — falha em silêncio nesse
    caso, nunca deixa isso travar o processamento de uma mensagem."""
    if not config.get("evolution_url") or config.get("status_conexao") != "conectado":
        return None
    requests = _requests()
    try:
        resp = requests.post(
            f"{config['evolution_url']}/chat/fetchProfilePictureUrl/{config['instancia_nome']}",
            json={"number": normalizar_telefone(telefone)},
            headers=_cabecalhos(config), timeout=15,
        )
        if resp.status_code >= 400:
            return None
        corpo = resp.json()
        return corpo.get("profilePictureUrl") or corpo.get("profilePicture") or None
    except Exception:
        return None


def atualizar_foto_contato(conn, config, contato_id: int, telefone: str):
    """Devolve a URL da foto e registra a tentativa.

    Se o WhatsApp não estiver conectado, NÃO registra nada: perguntar não
    foi possível, então não é uma resposta "esse contato não tem foto".
    Sem esse cuidado, todo contato que chegou num momento de conexão
    instável ficava marcado pra sempre como "já tentei" e nunca mais
    ganhava foto — era por isso que a lista aparecia só com as iniciais.
    """
    if config.get("status_conexao") != "conectado":
        return None
    url = buscar_foto_perfil_contato(config, telefone)
    conn.execute(
        "UPDATE whatsapp_contatos SET foto_url = ?, foto_atualizada_em = ? WHERE id = ?",
        (url, _now_iso(), contato_id),
    )
    return url


# Contato sem foto é tentado de novo de vez em quando: ele pode ter posto
# uma depois, ou ter aberto a privacidade. Com foto, não se insiste.
DIAS_RETENTAR_FOTO = 3


def _precisa_tentar_foto(contato: dict) -> bool:
    if contato.get("foto_url"):
        return False
    ultima = contato.get("foto_atualizada_em")
    if not ultima:
        return True
    try:
        quando = datetime.datetime.fromisoformat(str(ultima).rstrip("Z"))
    except (TypeError, ValueError):
        return True
    return (datetime.datetime.utcnow() - quando).days >= DIAS_RETENTAR_FOTO


def obter_ou_criar_contato(conn, empresa_id: int, telefone: str, nome: str = None):
    row = conn.execute("SELECT * FROM whatsapp_contatos WHERE empresa_id = ? AND telefone = ?", (empresa_id, telefone)).fetchone()
    if row:
        if nome and not row["nome"]:
            conn.execute("UPDATE whatsapp_contatos SET nome = ?, atualizado_em = ? WHERE id = ?",
                         (nome, _now_iso(), row["id"]))
        return dict(conn.execute("SELECT * FROM whatsapp_contatos WHERE id = ?", (row["id"],)).fetchone())
    agora = _now_iso()
    cur = conn.execute(
        "INSERT INTO whatsapp_contatos (empresa_id, telefone, nome, criado_em, atualizado_em) VALUES (?, ?, ?, ?, ?)",
        (empresa_id, telefone, nome, agora, agora),
    )
    return dict(conn.execute("SELECT * FROM whatsapp_contatos WHERE id = ?", (cur.lastrowid,)).fetchone())


def obter_apelidos_contatos(conn, usuario_id: int):
    """Apelidos privados que ESTE usuário deu pros contatos — {contato_id:
    apelido}. Ninguém mais vê esses nomes."""
    rows = conn.execute(
        "SELECT contato_id, apelido FROM whatsapp_contatos_apelidos WHERE usuario_id = ?", (usuario_id,)
    ).fetchall()
    return {r["contato_id"]: r["apelido"] for r in rows}


def definir_apelido_contato(conn, usuario_id: int, contato_id: int, apelido: str):
    """Apelido em branco remove o personalizado e volta a mostrar o nome
    de cadastro do contato."""
    apelido = (apelido or "").strip() or None
    if apelido is None:
        conn.execute(
            "DELETE FROM whatsapp_contatos_apelidos WHERE usuario_id = ? AND contato_id = ?",
            (usuario_id, contato_id),
        )
        return
    existe = conn.execute(
        "SELECT 1 FROM whatsapp_contatos_apelidos WHERE usuario_id = ? AND contato_id = ?",
        (usuario_id, contato_id),
    ).fetchone()
    if existe:
        conn.execute(
            "UPDATE whatsapp_contatos_apelidos SET apelido = ?, atualizado_em = ? WHERE usuario_id = ? AND contato_id = ?",
            (apelido, _now_iso(), usuario_id, contato_id),
        )
    else:
        conn.execute(
            "INSERT INTO whatsapp_contatos_apelidos (usuario_id, contato_id, apelido, atualizado_em) VALUES (?, ?, ?, ?)",
            (usuario_id, contato_id, apelido, _now_iso()),
        )


def salvar_contato_manual(conn, empresa_id: int, telefone_bruto: str, nome: str = None):
    """Diferente de obter_ou_criar_contato (que só preenche o nome se
    ainda estiver vazio, pra não sobrescrever à toa durante o fluxo
    automático de conversa), aqui é uma ação explícita do usuário — o
    nome informado sempre vale, inclusive pra renomear um contato que já
    existia."""
    telefone = normalizar_telefone(telefone_bruto)
    nome = (nome or "").strip() or None
    agora = _now_iso()
    row = conn.execute("SELECT id FROM whatsapp_contatos WHERE empresa_id = ? AND telefone = ?", (empresa_id, telefone)).fetchone()
    if row:
        conn.execute("UPDATE whatsapp_contatos SET nome = ?, atualizado_em = ? WHERE id = ?", (nome, agora, row["id"]))
        return dict(conn.execute("SELECT * FROM whatsapp_contatos WHERE id = ?", (row["id"],)).fetchone())
    cur = conn.execute(
        "INSERT INTO whatsapp_contatos (empresa_id, telefone, nome, criado_em, atualizado_em) VALUES (?, ?, ?, ?, ?)",
        (empresa_id, telefone, nome, agora, agora),
    )
    return dict(conn.execute("SELECT * FROM whatsapp_contatos WHERE id = ?", (cur.lastrowid,)).fetchone())


_COLUNAS_NOME_CSV = {"nome", "name", "contato", "contact"}
_COLUNAS_TELEFONE_CSV = {"telefone", "phone", "celular", "numero", "número", "tel", "whatsapp", "mobile"}


def _parsear_contatos_csv(conteudo: str):
    """Lê um CSV exportado de agenda de telefone/planilha — aceita várias
    variações comuns de nome de coluna (nome/name, telefone/phone/
    celular...), sem exigir um formato exato."""
    leitor = csv.DictReader(io.StringIO(conteudo))
    if not leitor.fieldnames:
        raise ApiError("CSV vazio ou sem cabeçalho.", status=400)
    coluna_nome = next((c for c in leitor.fieldnames if c and c.strip().lower() in _COLUNAS_NOME_CSV), None)
    coluna_telefone = next((c for c in leitor.fieldnames if c and c.strip().lower() in _COLUNAS_TELEFONE_CSV), None)
    if not coluna_telefone:
        raise ApiError(
            "Não encontrei uma coluna de telefone no CSV. Use um cabeçalho como 'nome,telefone'.", status=400,
        )
    contatos = []
    for linha in leitor:
        telefone = (linha.get(coluna_telefone) or "").strip()
        nome = (linha.get(coluna_nome) or "").strip() if coluna_nome else ""
        if telefone:
            contatos.append((nome or None, telefone))
    return contatos


def _parsear_contatos_vcf(conteudo: str):
    """Lê um arquivo .vcf (vCard) — formato padrão exportado por
    praticamente qualquer celular (iPhone, Android) ao compartilhar ou
    exportar contatos. Um contato com vários números vira uma entrada
    por número (cada número do WhatsApp é uma conversa separada)."""
    contatos = []
    nome_atual = None
    for linha_bruta in conteudo.splitlines():
        linha = linha_bruta.strip()
        if linha.upper().startswith("BEGIN:VCARD"):
            nome_atual = None
        elif linha.upper().startswith("FN:") or linha.upper().startswith("FN;"):
            nome_atual = linha.split(":", 1)[-1].strip() or None
        elif linha.upper().startswith("TEL"):
            telefone = linha.split(":", 1)[-1].strip()
            if telefone:
                contatos.append((nome_atual, telefone))
    return contatos


def importar_contatos(conn, empresa_id: int, conteudo: str, nome_arquivo: str):
    """Importa contatos em lote de um CSV ou VCF (exportado do celular),
    reaproveitando obter_ou_criar_contato — quem já existe não duplica,
    só atualiza o nome se ainda não tinha."""
    extensao = (nome_arquivo.rsplit(".", 1)[-1] if "." in nome_arquivo else "").lower()
    if extensao == "vcf":
        brutos = _parsear_contatos_vcf(conteudo)
    elif extensao == "csv":
        brutos = _parsear_contatos_csv(conteudo)
    else:
        raise ApiError("Formato não suportado — envie um arquivo .csv ou .vcf.", status=400)

    importados, ja_existiam, invalidos = 0, 0, 0
    vistos = set()
    for nome, telefone_bruto in brutos:
        try:
            telefone = normalizar_telefone(telefone_bruto)
        except ApiError:
            invalidos += 1
            continue
        if telefone in vistos:
            continue
        vistos.add(telefone)
        ja_existia = conn.execute("SELECT 1 FROM whatsapp_contatos WHERE empresa_id = ? AND telefone = ?", (empresa_id, telefone)).fetchone()
        obter_ou_criar_contato(conn, empresa_id, telefone, nome)
        if ja_existia:
            ja_existiam += 1
        else:
            importados += 1
    return {"importados": importados, "ja_existiam": ja_existiam, "invalidos": invalidos}


def obter_ou_criar_conversa(conn, contato_id: int):
    """Devolve (conversa, foi_criada_agora) — o segundo valor importa pra
    saber se é a primeira mensagem de um contato novo (dispara o menu de
    setor automático) ou uma conversa já existente."""
    row = conn.execute(
        "SELECT * FROM whatsapp_conversas WHERE contato_id = ? ORDER BY id DESC LIMIT 1", (contato_id,)
    ).fetchone()
    if row:
        return dict(row), False
    cur = conn.execute(
        "INSERT INTO whatsapp_conversas (contato_id, status, criado_em) VALUES (?, 'aberta', ?)",
        (contato_id, _now_iso()),
    )
    return dict(conn.execute("SELECT * FROM whatsapp_conversas WHERE id = ?", (cur.lastrowid,)).fetchone()), True


def atribuir_conversa(conn, conversa_id: int, usuario_id, atribuido_por: int):
    """usuario_id=None devolve a conversa pra fila (fica visível a todos
    de novo). Cada chamada grava uma linha no histórico
    (whatsapp_atribuicoes) — é essa trilha que o dashboard usa depois
    para calcular quanto tempo cada usuário passou responsável por cada
    conversa quando ela passa por mais de uma pessoa."""
    conn.execute("UPDATE whatsapp_conversas SET atribuida_usuario_id = ? WHERE id = ?", (usuario_id, conversa_id))
    conn.execute(
        "INSERT INTO whatsapp_atribuicoes (conversa_id, usuario_id, atribuido_por, criado_em) VALUES (?, ?, ?, ?)",
        (conversa_id, usuario_id, atribuido_por, _now_iso()),
    )


TEXTO_PESQUISA_SATISFACAO = (
    "Sua conversa foi encerrada. De 1 a 5, como você avalia o atendimento que recebeu? "
    "Responda só com o número e, se quiser, conte o que achou bom ou o que pode melhorar 🙂"
)


MINUTOS_COOLDOWN_PESQUISA = 60


def fechar_conversa(conn, conversa_id: int, resultado: str = None):
    """Fecha a conversa e dispara a pesquisa de satisfação pro cliente —
    melhor esforço: se o envio falhar (ex.: WhatsApp desconectado), a
    conversa fecha do mesmo jeito, só a mensagem da pesquisa fica
    registrada com status 'falhou' (mesmo padrão de qualquer outro envio
    deste sistema, ver enviar_mensagem em routes/whatsapp.py).

    Não manda a pesquisa de novo se esse mesmo contato já recebeu uma nos
    últimos MINUTOS_COOLDOWN_PESQUISA — cenário real: cliente liga nas
    coisas, fecha e chama de novo em minutos; não faz sentido perguntar
    "como foi o atendimento" toda vez.

    resultado: 'venda' | 'perdido' | None (não informado) — usado pro
    dashboard calcular taxa de conversão por região/setor/usuário."""
    agora = _now_iso()
    conversa = conn.execute(
        "SELECT c.*, ct.telefone, ct.empresa_id FROM whatsapp_conversas c JOIN whatsapp_contatos ct ON ct.id = c.contato_id WHERE c.id = ?",
        (conversa_id,),
    ).fetchone()

    desde = (datetime.datetime.utcnow() - datetime.timedelta(minutes=MINUTOS_COOLDOWN_PESQUISA)).strftime("%Y-%m-%dT%H:%M:%S.%fZ")
    pesquisa_recente = conn.execute(
        """
        SELECT 1 FROM whatsapp_mensagens m
        JOIN whatsapp_conversas c ON c.id = m.conversa_id
        WHERE c.contato_id = ? AND m.texto = ? AND m.criado_em >= ?
        """,
        (conversa["contato_id"], TEXTO_PESQUISA_SATISFACAO, desde),
    ).fetchone()

    # Zera qualquer menu em andamento — se a conversa for encerrada bem no
    # meio do menu de setor (cliente nunca respondeu), reabrir depois
    # precisa começar do zero, não continuar de onde parou.
    if pesquisa_recente:
        conn.execute(
            "UPDATE whatsapp_conversas SET status = 'fechada', fechada_em = ?, resultado = ?, menu_estado = NULL, menu_opcoes = NULL, menu_tentativas_invalidas = 0 WHERE id = ?",
            (agora, resultado, conversa_id),
        )
        return

    conn.execute(
        "UPDATE whatsapp_conversas SET status = 'fechada', fechada_em = ?, aguardando_avaliacao = 1, resultado = ?, menu_estado = NULL, menu_opcoes = NULL, menu_tentativas_invalidas = 0 WHERE id = ?",
        (agora, resultado, conversa_id),
    )
    config = obter_configuracao(conn, conversa["empresa_id"])
    try:
        externo_id = enviar_texto(config, conversa["telefone"], TEXTO_PESQUISA_SATISFACAO)
        status_msg, erro = "enviada", None
    except ApiError as e:
        externo_id, status_msg, erro = None, "falhou", e.mensagem
    conn.execute(
        """
        INSERT INTO whatsapp_mensagens (conversa_id, direcao, tipo, texto, externo_id, status, erro, criado_em)
        VALUES (?, 'saida', 'texto', ?, ?, ?, ?, ?)
        """,
        (conversa_id, TEXTO_PESQUISA_SATISFACAO, externo_id, status_msg, erro, agora),
    )


def reabrir_conversa(conn, conversa_id: int):
    conn.execute(
        "UPDATE whatsapp_conversas SET status = 'aberta', fechada_em = NULL, aguardando_avaliacao = 0 WHERE id = ?",
        (conversa_id,),
    )


# ============================================================
# DASHBOARD (admin) — tempo de resposta/atendimento por usuário.
#
# Implementado em Python (não em SQL agregado) de propósito: o cálculo
# de "tempo até a próxima resposta" percorre as mensagens de cada
# conversa em ordem, mensagem a mensagem — mais claro de ler e de
# ajustar aqui do que numa consulta SQL só com window functions. Custo:
# uma consulta por conversa (N+1) — aceitável na escala de uma caixa de
# entrada de WhatsApp de uma empresa pequena/média; se um dia isso virar
# gargalo de verdade, dá pra reescrever com uma janela SQL sem mudar o
# formato da resposta.
# ============================================================
def _diferenca_minutos(iso_inicio, iso_fim):
    def _parse(s):
        return datetime.datetime.fromisoformat(s.replace("Z", "+00:00"))
    return (_parse(iso_fim) - _parse(iso_inicio)).total_seconds() / 60.0


def _media(valores):
    return round(sum(valores) / len(valores), 1) if valores else None


def resetar_dashboard(conn, empresa_id: int):
    """Não apaga NADA — só marca a partir de quando os contadores do
    Dashboard voltam a contar (ver calcular_dashboard). As conversas e
    mensagens de antes continuam salvas normalmente, só saem da conta."""
    conn.execute(
        "UPDATE configuracoes_whatsapp SET dashboard_reset_em = ? WHERE empresa_id = ?", (_now_iso(), empresa_id)
    )


def calcular_dashboard(conn, empresa_id: int):
    config_dash = obter_configuracao(conn, empresa_id)
    reset_em = config_dash.get("dashboard_reset_em")
    # Mesmo limite usado pelo alerta de conversa parada (ver
    # listar_conversas_sla_estourado) — o Dashboard conta quantas vezes
    # cada um passou desse tempo pra responder o cliente.
    limite_demora_min = config_dash.get("sla_minutos_alerta") or 15
    filtro_data = " AND criado_em >= ?" if reset_em else ""
    filtro_data_c = " AND c.criado_em >= ?" if reset_em else ""
    filtro_data_a = " AND a.criado_em >= ?" if reset_em else ""
    params_data = (reset_em,) if reset_em else ()

    # Conversas que ESTÃO paradas agora (cliente esperando resposta há
    # mais que o limite), agrupadas por responsável.
    paradas_por_usuario = {}
    for c in listar_conversas_sla_estourado(conn, empresa_id):
        if c.get("atribuida_usuario_id"):
            paradas_por_usuario[c["atribuida_usuario_id"]] = paradas_por_usuario.get(c["atribuida_usuario_id"], 0) + 1

    usuarios = conn.execute("SELECT * FROM usuarios WHERE empresa_id = ? ORDER BY nome", (empresa_id,)).fetchall()
    resultado_usuarios = []

    for u in usuarios:
        uid = u["id"]
        conversas = conn.execute(
            f"SELECT * FROM whatsapp_conversas WHERE atribuida_usuario_id = ?{filtro_data}", (uid, *params_data)
        ).fetchall()
        mensagens_enviadas = conn.execute(
            f"SELECT COUNT(*) AS n FROM whatsapp_mensagens WHERE usuario_id = ? AND direcao = 'saida'{filtro_data}",
            (uid, *params_data),
        ).fetchone()["n"]

        duracoes_atendimento = []
        tempos_primeira_resposta = []
        tempos_resposta = []

        for c in conversas:
            if c["status"] == "fechada" and c["fechada_em"]:
                duracoes_atendimento.append(_diferenca_minutos(c["criado_em"], c["fechada_em"]))

            msgs = conn.execute(
                "SELECT direcao, criado_em FROM whatsapp_mensagens WHERE conversa_id = ? ORDER BY criado_em, id",
                (c["id"],),
            ).fetchall()
            ja_registrou_primeira = False
            for i, m in enumerate(msgs):
                if m["direcao"] != "entrada":
                    continue
                for seguinte in msgs[i + 1:]:
                    if seguinte["direcao"] == "saida":
                        delta = _diferenca_minutos(m["criado_em"], seguinte["criado_em"])
                        tempos_resposta.append(delta)
                        if not ja_registrou_primeira:
                            tempos_primeira_resposta.append(delta)
                            ja_registrou_primeira = True
                        break

        avaliacoes = conn.execute(
            f"SELECT nota FROM whatsapp_avaliacoes WHERE usuario_id = ?{filtro_data}", (uid, *params_data)
        ).fetchall()
        notas = [a["nota"] for a in avaliacoes]

        resultado_usuarios.append({
            "id": uid, "nome": u["nome"], "email": u["email"], "admin": bool(u["admin"]), "ativo": bool(u["ativo"]),
            "conversas_atribuidas": len(conversas),
            "conversas_abertas": sum(1 for c in conversas if c["status"] == "aberta"),
            "conversas_fechadas": sum(1 for c in conversas if c["status"] == "fechada"),
            "nao_lidas_pendentes": sum(c["nao_lidas"] or 0 for c in conversas),
            "mensagens_enviadas": mensagens_enviadas,
            "tempo_medio_primeira_resposta_min": _media(tempos_primeira_resposta),
            "tempo_medio_resposta_min": _media(tempos_resposta),
            "tempo_medio_atendimento_min": _media(duracoes_atendimento),
            "media_avaliacao": _media(notas),
            "total_avaliacoes": len(notas),
            # Demora: quantas vezes deixou o cliente esperando mais que o
            # limite, e quantas conversas estão paradas assim AGORA.
            "respostas_demoradas": sum(1 for t in tempos_resposta if t is not None and t > limite_demora_min),
            "total_respostas": len(tempos_resposta),
            "paradas_agora": paradas_por_usuario.get(uid, 0),
            "pior_demora_min": max(tempos_resposta) if tempos_resposta else None,
        })

    # Ranking de negociações fechadas — o "controle total" que o admin
    # pediu: quem mais fecha conversas primeiro, com empate desempatado
    # por melhor tempo médio de atendimento (fechar rápido E bem conta
    # mais que só fechar muito).
    ranking = sorted(
        [u for u in resultado_usuarios if u["conversas_fechadas"] > 0],
        key=lambda u: (-u["conversas_fechadas"], u["tempo_medio_atendimento_min"] or float("inf")),
    )

    avaliacoes_recentes = conn.execute(
        f"""
        SELECT a.nota, a.comentario, a.criado_em, u.nome AS usuario_nome, ct.nome AS contato_nome, ct.telefone
        FROM whatsapp_avaliacoes a
        LEFT JOIN usuarios u ON u.id = a.usuario_id
        JOIN whatsapp_conversas c ON c.id = a.conversa_id
        JOIN whatsapp_contatos ct ON ct.id = c.contato_id
        WHERE ct.empresa_id = ?{filtro_data_a}
        ORDER BY a.criado_em DESC
        LIMIT 20
        """,
        (empresa_id, *params_data),
    ).fetchall()

    hoje = _now_iso()[:10]
    base_conversas = f"FROM whatsapp_conversas c JOIN whatsapp_contatos ct ON ct.id = c.contato_id WHERE ct.empresa_id = ?{filtro_data_c}"
    totais = {
        "conversas": conn.execute(f"SELECT COUNT(*) AS n {base_conversas}", (empresa_id, *params_data)).fetchone()["n"],
        "fila": conn.execute(f"SELECT COUNT(*) AS n {base_conversas} AND c.atribuida_usuario_id IS NULL", (empresa_id, *params_data)).fetchone()["n"],
        "abertas": conn.execute(f"SELECT COUNT(*) AS n {base_conversas} AND c.status = 'aberta'", (empresa_id, *params_data)).fetchone()["n"],
        "fechadas": conn.execute(f"SELECT COUNT(*) AS n {base_conversas} AND c.status = 'fechada'", (empresa_id, *params_data)).fetchone()["n"],
        "mensagens_hoje": conn.execute(
            "SELECT COUNT(*) AS n FROM whatsapp_mensagens m JOIN whatsapp_conversas c ON c.id = m.conversa_id "
            "JOIN whatsapp_contatos ct ON ct.id = c.contato_id WHERE ct.empresa_id = ? AND m.criado_em LIKE ?",
            (empresa_id, hoje + "%"),
        ).fetchone()["n"],
        "dashboard_reset_em": reset_em,
        "limite_demora_min": limite_demora_min,
        "paradas_agora": sum(paradas_por_usuario.values()),
        "media_avaliacao_geral": _media([r["nota"] for r in conn.execute(
            f"SELECT a.nota FROM whatsapp_avaliacoes a JOIN whatsapp_conversas c ON c.id = a.conversa_id "
            f"JOIN whatsapp_contatos ct ON ct.id = c.contato_id WHERE ct.empresa_id = ?{filtro_data_a}",
            (empresa_id, *params_data),
        ).fetchall()]),
    }
    return {
        "usuarios": resultado_usuarios,
        "ranking_fechadas": ranking,
        "avaliacoes_recentes": [dict(a) for a in avaliacoes_recentes],
        "totais": totais,
    }


def calcular_mapa_regioes(conn, empresa_id: int):
    """Agrega leads (contatos), atendimentos (conversas) e vendas por
    região/estado — descobertos automaticamente pelo DDD do telefone do
    contato, sem precisar perguntar nada pra ele."""
    linhas = conn.execute(
        """
        SELECT ct.id AS contato_id, ct.telefone,
               c.id AS conversa_id, c.resultado
        FROM whatsapp_contatos ct
        LEFT JOIN whatsapp_conversas c ON c.contato_id = ct.id AND c.excluida_em IS NULL
        WHERE ct.empresa_id = ?
        """,
        (empresa_id,),
    ).fetchall()

    por_regiao, por_estado = {}, {}

    def _bucket(mapa, chave, regiao=None):
        if chave not in mapa:
            mapa[chave] = {"leads": set(), "atendimentos": 0, "vendas": 0, "perdidos": 0}
            if regiao is not None:
                mapa[chave]["regiao"] = regiao
        return mapa[chave]

    for linha in linhas:
        uf, regiao = regiao_do_telefone(linha["telefone"])
        if not uf:
            uf, regiao = "??", "Não identificado"
        b_regiao = _bucket(por_regiao, regiao)
        b_estado = _bucket(por_estado, uf, regiao)
        b_regiao["leads"].add(linha["contato_id"])
        b_estado["leads"].add(linha["contato_id"])
        if linha["conversa_id"] is not None:
            b_regiao["atendimentos"] += 1
            b_estado["atendimentos"] += 1
            if linha["resultado"] == "venda":
                b_regiao["vendas"] += 1
                b_estado["vendas"] += 1
            elif linha["resultado"] == "perdido":
                b_regiao["perdidos"] += 1
                b_estado["perdidos"] += 1

    def _finalizar(mapa, com_regiao):
        saida = []
        for chave, dados in mapa.items():
            fechadas = dados["vendas"] + dados["perdidos"]
            item = {
                "leads": len(dados["leads"]),
                "atendimentos": dados["atendimentos"],
                "vendas": dados["vendas"],
                "taxa_conversao": round((dados["vendas"] / fechadas) * 100, 1) if fechadas else None,
            }
            if com_regiao:
                item["estado"] = chave
                item["regiao"] = dados["regiao"]
            else:
                item["regiao"] = chave
            saida.append(item)
        return saida

    regioes = sorted(_finalizar(por_regiao, com_regiao=False), key=lambda x: -x["leads"])
    estados = sorted(_finalizar(por_estado, com_regiao=True), key=lambda x: -x["leads"])
    return {"regioes": regioes, "estados": estados}


def _processar_mensagem_recebida(conn, config, dados: dict):
    empresa_id = config["empresa_id"]
    chave = dados.get("key") or {}
    if chave.get("fromMe"):
        return {"processado": False, "tipo": "eco_propria_mensagem"}

    remote_jid = chave.get("remoteJid") or ""
    # Baileys às vezes manda o JID no formato multi-device
    # "<numero>:<idDoAparelho>@s.whatsapp.net" — sem cortar a parte depois
    # dos ":", o ID do aparelho grudava nos dígitos do telefone e
    # corrompia o número (contato salvo errado, todo envio pra ele
    # falhando com "Bad Request" na Evolution API). Corta ambos os lados.
    telefone_bruto = remote_jid.split("@")[0].split(":")[0]
    if not telefone_bruto:
        return {"processado": False, "tipo": "sem_remetente"}
    # GRUPO: a conversa é o grupo inteiro, e quem falou vem noutro campo
    # (key.participant). Sem separar os dois, todas as falas do grupo
    # ficavam sem dono — não dava pra saber quem tinha pedido o quê.
    #
    # O id do grupo também não passa pela normalização de telefone: ele
    # não tem DDD nem o 9 do celular, e "corrigir" isso o transformaria
    # num identificador que não existe.
    de_grupo = remote_jid.endswith("@g.us")
    autor_nome, autor_telefone = None, None
    if de_grupo:
        telefone = _somente_digitos(telefone_bruto)
        autor_nome, autor_telefone = _autor_da_mensagem_de_grupo(dados, chave)
    else:
        # Normaliza pro formato completo com o 9 (ver normalizar_telefone)
        # — sem isso, a mesma pessoa vira dois contatos diferentes
        # dependendo de qual formato de JID o WhatsApp mandou daquela vez.
        try:
            telefone = normalizar_telefone(telefone_bruto)
        except ApiError:
            telefone = telefone_bruto

    externo_id = chave.get("id")
    if externo_id:
        ja_existe = conn.execute(
            """
            SELECT 1 FROM whatsapp_mensagens m
            JOIN whatsapp_conversas c ON c.id = m.conversa_id
            JOIN whatsapp_contatos ct ON ct.id = c.contato_id
            WHERE m.externo_id = ? AND ct.empresa_id = ?
            """,
            (externo_id, empresa_id),
        ).fetchone()
        if ja_existe:
            return {"processado": True, "tipo": "duplicada_ignorada"}

    # Reação: atualiza a mensagem reagida e encerra. Antes disso caía no
    # fluxo comum e virava uma bolha em branco no meio da conversa.
    reacao = _extrair_reacao(dados)
    if reacao is not None:
        id_alvo, emoji = reacao
        aplicada = _aplicar_reacao(conn, empresa_id, id_alvo, emoji)
        return {"processado": True, "tipo": "reacao", "aplicada": aplicada}

    # Em grupo o pushName é de quem falou; usar isso como nome do contato
    # renomearia o grupo a cada mensagem, com o nome do último que
    # escreveu.
    nome_contato = None if de_grupo else dados.get("pushName")
    contato = obter_ou_criar_contato(conn, empresa_id, telefone, nome_contato)
    if de_grupo and not contato.get("eh_grupo"):
        conn.execute("UPDATE whatsapp_contatos SET eh_grupo = 1 WHERE id = ?", (contato["id"],))
        contato["eh_grupo"] = 1
    # Não busca a foto em toda mensagem: quem já tem foto não é
    # consultado de novo, e quem não tem só é tentado a cada poucos dias
    # (ver _precisa_tentar_foto).
    if _precisa_tentar_foto(contato):
        nova = atualizar_foto_contato(conn, config, contato["id"], telefone)
        if nova:
            contato["foto_url"] = nova
    conversa, conversa_nova = obter_ou_criar_conversa(conn, contato["id"])
    texto = _extrair_texto(dados)
    agora = _now_iso()

    # Imagem/vídeo/documento/áudio mandado pelo cliente — baixa e salva
    # de verdade (não só a legenda). Se der errado ao salvar, não perde a
    # mensagem inteira: cai pra texto simples (com a legenda, se tiver).
    tipo_msg, midia_url = "texto", None
    midia = _extrair_midia(dados, config, remote_jid, externo_id)
    if midia:
        midia_tipo, midia_base64, midia_nome = midia
        try:
            midia_url = _salvar_midia_recebida(midia_base64, midia_nome)
            tipo_msg = midia_tipo
        except Exception:
            pass
    preview = texto or {"imagem": "📷 Imagem", "video": "🎥 Vídeo", "documento": "📄 Documento", "audio": "🎵 Áudio"}.get(tipo_msg, "")

    # Conversa nova de um contato novo: grava a mensagem normalmente (fica
    # no histórico), mas em vez de cair direto na fila geral, dispara o
    # menu de setores pro cliente escolher.
    if conversa_nova:
        conn.execute(
            """
            INSERT INTO whatsapp_mensagens (conversa_id, direcao, tipo, texto, midia_url, externo_id, status, criado_em,
                                            autor_nome, autor_telefone)
            VALUES (?, 'entrada', ?, ?, ?, ?, 'recebida', ?, ?, ?)
            """,
            (conversa["id"], tipo_msg, texto, midia_url, externo_id, agora, autor_nome, autor_telefone),
        )
        conn.execute(
            "UPDATE whatsapp_conversas SET nao_lidas = nao_lidas + 1, ultima_mensagem_em = ?, ultima_mensagem_preview = ? WHERE id = ?",
            (agora, preview[:120], conversa["id"]),
        )
        # Menu de setores NÃO vai pra grupo: ele existe pra direcionar UM
        # cliente ao setor certo. Mandado num grupo, todo mundo receberia
        # "escolha o número do setor" e a primeira pessoa a responder
        # decidiria o destino da conversa inteira — sem falar no
        # constrangimento de um menu automático no meio de uma conversa
        # entre pessoas. Grupo entra direto como conversa normal.
        if not de_grupo:
            _iniciar_menu_setor(conn, empresa_id, conversa["id"], telefone)
            return {"processado": True, "tipo": "menu_iniciado", "conversa_id": conversa["id"]}
        # Grupo: a mensagem já foi gravada acima. Sai aqui mesmo — sem
        # este retorno ela seria inserida uma segunda vez pelo trecho
        # das mensagens comuns, mais abaixo.
        return {"processado": True, "tipo": "recebida_grupo", "conversa_id": conversa["id"]}

    # Se esta conversa está no meio do menu de setor/atendente (ver
    # acima), tenta interpretar ESTA mensagem como a escolha do cliente
    # antes de tratá-la como mensagem comum.
    if conversa["menu_estado"]:
        return _tratar_resposta_menu(conn, empresa_id, conversa, telefone, texto, externo_id, agora)

    # Se esta conversa está esperando a resposta da pesquisa de
    # satisfação (ver fechar_conversa), tenta interpretar ESTA mensagem
    # como a nota antes de tratá-la como uma mensagem comum — se não
    # conseguir achar um número de 1 a 5 nela, cai pro fluxo normal
    # abaixo (mensagem comum, reabre a conversa).
    if conversa["aguardando_avaliacao"]:
        resultado = _tentar_capturar_avaliacao(conn, empresa_id, conversa, telefone, texto, externo_id, agora)
        if resultado is not None:
            return resultado

    estava_fechada = conversa["status"] == "fechada"

    conn.execute(
        """
        INSERT INTO whatsapp_mensagens (conversa_id, direcao, tipo, texto, midia_url, externo_id, status, criado_em,
                                        autor_nome, autor_telefone)
        VALUES (?, 'entrada', ?, ?, ?, ?, 'recebida', ?, ?, ?)
        """,
        (conversa["id"], tipo_msg, texto, midia_url, externo_id, agora, autor_nome, autor_telefone),
    )
    conn.execute(
        """
        UPDATE whatsapp_conversas
        SET status = 'aberta', nao_lidas = nao_lidas + 1, ultima_mensagem_em = ?, ultima_mensagem_preview = ?,
            ultima_msg_cliente_em = ?, followup_adiado_ate = NULL
        WHERE id = ?
        """,
        (agora, preview[:120], agora, conversa["id"]),
    )

    if estava_fechada:
        # A saudação/menu de setor só é reenviada em DOIS casos: contato
        # totalmente novo (ver conversa_nova acima) ou uma conversa que
        # tinha sido ENCERRADA e o cliente chamou de novo — nunca no meio
        # de um atendimento em andamento (isso já não existe mais desde
        # que tiramos o gatilho por "menu"/"voltar").
        atribuir_conversa(conn, conversa["id"], None, None)
        _iniciar_menu_setor(conn, empresa_id, conversa["id"], telefone)
        return {"processado": True, "tipo": "menu_reiniciado_pos_encerramento", "conversa_id": conversa["id"]}

    _avisar_fora_expediente_se_preciso(conn, empresa_id, conversa, telefone)
    return {"processado": True, "tipo": "mensagem_recebida", "conversa_id": conversa["id"]}


# ============================================================
# HORÁRIO DE FUNCIONAMENTO — aviso automático fora do expediente
# ============================================================
HORAS_ENTRE_AVISOS_EXPEDIENTE = 6


def _dentro_do_expediente(janelas_json) -> bool:
    try:
        janelas = json.loads(janelas_json or "[]")
    except (ValueError, TypeError):
        return True
    if not janelas:
        return True
    agora = datetime.datetime.now().strftime("%H:%M")
    return any(j.get("inicio") and j.get("fim") and j["inicio"] <= agora <= j["fim"] for j in janelas)


def _avisar_fora_expediente_se_preciso(conn, empresa_id, conversa, telefone):
    config = obter_configuracao(conn, empresa_id)
    if not config.get("expediente_ativo"):
        return
    if _dentro_do_expediente(config.get("expediente_janelas")):
        return
    ultimo_aviso = conversa.get("ultimo_aviso_expediente")
    if ultimo_aviso:
        try:
            instante = datetime.datetime.strptime(ultimo_aviso, "%Y-%m-%dT%H:%M:%S.%fZ")
            if (datetime.datetime.utcnow() - instante).total_seconds() < HORAS_ENTRE_AVISOS_EXPEDIENTE * 3600:
                return
        except ValueError:
            pass
    mensagem = config.get("expediente_mensagem") or (
        "No momento estamos fora do horário de atendimento. Assim que reabrirmos, retornaremos sua mensagem! 🙏"
    )
    try:
        enviar_texto(config, telefone, mensagem)
    except ApiError:
        pass
    conn.execute("UPDATE whatsapp_conversas SET ultimo_aviso_expediente = ? WHERE id = ?", (_now_iso(), conversa["id"]))


# ============================================================
# MENU AUTOMÁTICO DE SETOR — primeira mensagem de um contato novo
# ============================================================
SAUDACAO_PADRAO = "Olá! 👋 Para te atender melhor, escolha o setor desejado (responda só com o número):"


def obter_setores(conn, empresa_id: int):
    """Lista os nomes dos setores cadastrados dessa empresa, na ordem
    definida — é essa ordem que corresponde aos números do menu que o
    cliente recebe no WhatsApp (ver _texto_menu_setores)."""
    rows = conn.execute(
        "SELECT nome FROM whatsapp_setores WHERE empresa_id = ? ORDER BY ordem, id", (empresa_id,)
    ).fetchall()
    return [r["nome"] for r in rows]


def criar_setor(conn, empresa_id: int, nome: str):
    nome = (nome or "").strip()
    if not nome:
        raise ApiError("Informe o nome do setor.", status=400)
    existe = conn.execute(
        "SELECT 1 FROM whatsapp_setores WHERE empresa_id = ? AND nome = ?", (empresa_id, nome)
    ).fetchone()
    if existe:
        raise ApiError("Já existe um setor com esse nome.", status=409, codigo="setor_duplicado")
    maior_ordem = conn.execute(
        "SELECT COALESCE(MAX(ordem), -1) AS m FROM whatsapp_setores WHERE empresa_id = ?", (empresa_id,)
    ).fetchone()["m"]
    conn.execute(
        "INSERT INTO whatsapp_setores (empresa_id, nome, ordem, criado_em) VALUES (?, ?, ?, ?)",
        (empresa_id, nome, maior_ordem + 1, _now_iso()),
    )
    return obter_setores(conn, empresa_id)


def renomear_setor(conn, empresa_id: int, setor_id: int, nome_novo: str):
    nome_novo = (nome_novo or "").strip()
    if not nome_novo:
        raise ApiError("Informe o novo nome do setor.", status=400)
    atual = conn.execute(
        "SELECT nome FROM whatsapp_setores WHERE id = ? AND empresa_id = ?", (setor_id, empresa_id)
    ).fetchone()
    if atual is None:
        raise ApiError("Setor não encontrado.", status=404, codigo="nao_encontrado")
    duplicado = conn.execute(
        "SELECT 1 FROM whatsapp_setores WHERE empresa_id = ? AND nome = ? AND id != ?",
        (empresa_id, nome_novo, setor_id),
    ).fetchone()
    if duplicado:
        raise ApiError("Já existe um setor com esse nome.", status=409, codigo="setor_duplicado")
    nome_antigo = atual["nome"]
    conn.execute("UPDATE whatsapp_setores SET nome = ? WHERE id = ?", (nome_novo, setor_id))
    # Propaga o nome novo pra quem já usava o antigo — senão usuários e
    # conversas já atribuídas ficariam mostrando o nome que não existe mais.
    conn.execute("UPDATE usuarios SET setor = ? WHERE empresa_id = ? AND setor = ?", (nome_novo, empresa_id, nome_antigo))
    conn.execute(
        "UPDATE whatsapp_conversas SET menu_setor = ? WHERE menu_setor = ? AND contato_id IN "
        "(SELECT id FROM whatsapp_contatos WHERE empresa_id = ?)",
        (nome_novo, nome_antigo, empresa_id),
    )
    return obter_setores(conn, empresa_id)


def excluir_setor(conn, empresa_id: int, setor_id: int) -> bool:
    cur = conn.execute("DELETE FROM whatsapp_setores WHERE id = ? AND empresa_id = ?", (setor_id, empresa_id))
    return cur.rowcount > 0


def setores_do_usuario(conn, usuario_id: int) -> list:
    """Todos os setores que a pessoa atende. Uma pessoa pode estar em
    mais de um (ex.: Televendas e Financeiro) e recebe as conversas de
    todos eles."""
    rows = conn.execute(
        "SELECT setor FROM usuario_setores WHERE usuario_id = ? ORDER BY setor", (usuario_id,)
    ).fetchall()
    return [r["setor"] for r in rows]


def definir_setores_do_usuario(conn, usuario_id: int, setores: list):
    """Regrava a lista inteira. usuarios.setor fica com o primeiro, como
    setor principal — é o rótulo usado onde só cabe um (ver a migration
    schema_033)."""
    limpos, vistos = [], set()
    for s in setores or []:
        nome = (s or "").strip()
        if nome and nome.lower() not in vistos:
            vistos.add(nome.lower())
            limpos.append(nome)
    conn.execute("DELETE FROM usuario_setores WHERE usuario_id = ?", (usuario_id,))
    for nome in limpos:
        conn.execute("INSERT INTO usuario_setores (usuario_id, setor) VALUES (?, ?)", (usuario_id, nome))
    conn.execute("UPDATE usuarios SET setor = ? WHERE id = ?", (limpos[0] if limpos else None, usuario_id))
    return limpos


def setores_por_usuario(conn, usuario_ids: list):
    """Setores de vários usuários de uma vez — evita uma consulta por
    linha na tela de Usuários."""
    if not usuario_ids:
        return {}
    marcadores = ",".join("?" * len(usuario_ids))
    rows = conn.execute(
        f"SELECT usuario_id, setor FROM usuario_setores WHERE usuario_id IN ({marcadores}) ORDER BY setor",
        list(usuario_ids),
    ).fetchall()
    mapa = {}
    for r in rows:
        mapa.setdefault(r["usuario_id"], []).append(r["setor"])
    return mapa


def setores_com_alguem_online(conn, empresa_id: int):
    """Quais setores têm pelo menos uma pessoa disponível agora. Uma
    consulta só (em vez de uma por setor) porque isso roda a cada menu
    enviado. Quem atende dois setores conta nos dois."""
    limite = (datetime.datetime.utcnow() - datetime.timedelta(minutes=MINUTOS_ONLINE)).strftime("%Y-%m-%dT%H:%M:%S.%fZ")
    rows = conn.execute(
        """
        SELECT DISTINCT us.setor FROM usuario_setores us
        JOIN usuarios u ON u.id = us.usuario_id
        WHERE u.empresa_id = ? AND u.ativo = 1
          AND u.ultimo_acesso >= ? AND u.offline_forcado = 0 AND u.ausente = 0
        """,
        (empresa_id, limite),
    ).fetchall()
    return {r["setor"] for r in rows}


def _rodape_disponibilidade(setores, setores_online):
    """Avisa, junto do menu, quem está atendendo neste instante — assim o
    cliente não escolhe um setor vazio pra só depois descobrir que
    ninguém vai responder. Se não há ninguém em lugar nenhum, avisa de
    uma vez em vez de deixar ele escolher à toa."""
    if not setores:
        return ""
    disponiveis = [s for s in setores if s in (setores_online or set())]
    if not disponiveis:
        return "\n\n🌙 _No momento não há atendentes online. Pode deixar sua mensagem que retornamos assim que possível._"
    if len(disponiveis) == len(setores):
        return "\n\n🟢 _Todos os setores estão atendendo agora._"
    return "\n\n🟢 *Atendendo agora:* " + ", ".join(disponiveis)


def _texto_menu_setores(config=None, setores=None, setores_online=None):
    """Se o admin escreveu uma saudação personalizada em Configuração, ela
    é usada INTEIRA (inclusive a listagem de setores, do jeito que ele
    escreveu — números, nomes, tudo) — não gruda mais nenhuma lista
    automática depois. Sem isso não teria como deixar o texto do jeito
    que o admin realmente quer (pontuação, nomes por extenso etc.). Sem
    personalização nenhuma, usa o padrão com a lista gerada automática a
    partir dos setores cadastrados.

    O aviso de disponibilidade vai no fim nos dois casos — é informação
    que muda a cada minuto, então não dá pra deixar escrita à mão."""
    saudacao = (config or {}).get("saudacao_mensagem")
    rodape = _rodape_disponibilidade(setores, setores_online)
    if saudacao:
        return saudacao + rodape
    linhas = "\n".join(f"{i + 1}. {s}" for i, s in enumerate(setores or []))
    return f"{SAUDACAO_PADRAO}\n\n{linhas}{rodape}"


def usuario_esta_online(ultimo_acesso, offline_forcado=0, ausente=0) -> bool:
    """Disponível de verdade pra atender.

    Três coisas diferentes tiram alguém daqui: estar sem acessar há
    tempo (offline), ter sido marcado como afastado pelo admin
    (offline_forcado) e ter avisado que saiu (ausente). Só a primeira é
    deduzida; as outras duas alguém declarou."""
    if offline_forcado or ausente:
        return False
    if not ultimo_acesso:
        return False
    try:
        instante = datetime.datetime.strptime(ultimo_acesso, "%Y-%m-%dT%H:%M:%S.%fZ")
    except (ValueError, TypeError):
        return False
    return (datetime.datetime.utcnow() - instante) < datetime.timedelta(minutes=MINUTOS_ONLINE)


def usuarios_online_do_setor(conn, empresa_id: int, setor: str):
    limite = (datetime.datetime.utcnow() - datetime.timedelta(minutes=MINUTOS_ONLINE)).strftime("%Y-%m-%dT%H:%M:%S.%fZ")
    rows = conn.execute(
        """
        SELECT id, nome FROM usuarios
        WHERE empresa_id = ? AND setor = ? AND ativo = 1 AND ultimo_acesso >= ? AND offline_forcado = 0 AND ausente = 0
        ORDER BY nome
        """,
        (empresa_id, setor, limite),
    ).fetchall()
    return [dict(r) for r in rows]


SETOR_FALLBACK_PADRAO = "Controladoria"
TENTATIVAS_MENU_ANTES_DO_FALLBACK = 2


def _iniciar_menu_setor(conn, empresa_id: int, conversa_id: int, telefone: str):
    setores = obter_setores(conn, empresa_id)
    conn.execute(
        "UPDATE whatsapp_conversas SET menu_estado = 'setor', menu_opcoes = ?, menu_tentativas_invalidas = 0 WHERE id = ?",
        (json.dumps(setores), conversa_id),
    )
    try:
        config = obter_configuracao(conn, empresa_id)
        online = setores_com_alguem_online(conn, empresa_id)
        enviar_texto(config, telefone, _texto_menu_setores(config, setores, online))
    except ApiError:
        pass


def _rotear_para_setor(conn, empresa_id, conversa, setor, _responder):
    """Núcleo comum de "encaminhar pro setor X", usado quando o cliente
    escolhe um número válido no menu. Sempre limpa o estado de menu no
    final (assumido ou não, o roteamento terminou aqui)."""
    online = usuarios_online_do_setor(conn, empresa_id, setor)
    if not online:
        # Diferente dos outros dois casos abaixo, aqui NÃO limpa o menu —
        # deixa o cliente tentar outro setor (digitando outro número) em
        # vez de só deixá-lo esperando sem alternativa. menu_setor fica
        # marcado (mostra a etiqueta na lista), mas o menu continua ativo;
        # zera as tentativas invalidas pra ele ter as 2 chances de novo.
        setores = obter_setores(conn, empresa_id)
        conn.execute(
            "UPDATE whatsapp_conversas SET menu_estado = 'setor', menu_opcoes = ?, menu_tentativas_invalidas = 0, menu_setor = ? WHERE id = ?",
            (json.dumps(setores), setor, conversa["id"]),
        )
        # Em vez de só mandar "tente outro", diz QUAIS estão atendendo —
        # senão o cliente fica chutando número até achar um com gente.
        disponiveis = [s for s in setores if s in setores_com_alguem_online(conn, empresa_id)]
        if disponiveis:
            sugestao = (
                f"\n\nSe preferir falar com alguém agora, estes setores estão atendendo: "
                f"*{', '.join(disponiveis)}* — é só digitar o número correspondente."
            )
        else:
            sugestao = ""
        _responder(
            f"No momento não há ninguém disponível em *{setor}*. "
            f"Sua mensagem já foi registrada e assim que um consultor estiver disponível você será atendido. 🙏{sugestao}"
        )
        return {"processado": True, "tipo": "menu_setor_sem_online", "conversa_id": conversa["id"]}

    if len(online) == 1:
        atendente = online[0]
        atribuir_conversa(conn, conversa["id"], atendente["id"], None)
        conn.execute(
            "UPDATE whatsapp_conversas SET menu_estado = NULL, menu_opcoes = NULL, menu_setor = ? WHERE id = ?",
            (setor, conversa["id"]),
        )
        _responder(f"Você foi direcionado(a) para {atendente['nome']} ({setor}). Só um momento! 😊")
        return {"processado": True, "tipo": "menu_atribuido", "conversa_id": conversa["id"]}

    # Mais de uma pessoa online no setor — deixa o cliente escolher com
    # quem falar, em vez de decidir por ele.
    conn.execute(
        "UPDATE whatsapp_conversas SET menu_estado = 'atendente', menu_opcoes = ?, menu_setor = ? WHERE id = ?",
        (json.dumps(online), setor, conversa["id"]),
    )
    linhas = "\n".join(f"{i + 1}. {u['nome']}" for i, u in enumerate(online))
    _responder(f"Temos mais de uma pessoa disponível em {setor}. Com quem você quer falar?\n\n{linhas}")
    return {"processado": True, "tipo": "menu_atendentes_mostrado", "conversa_id": conversa["id"]}


def _tratar_resposta_menu(conn, empresa_id, conversa, telefone, texto, externo_id, agora):
    """Interpreta a resposta do cliente ao menu de setor OU ao submenu de
    atendente (quando o setor escolhido tem mais de uma pessoa online —
    ver menu_estado == 'atendente'). Sempre trata (nunca devolve None) —
    mensagens fora do formato esperado só pedem o número nunca de novo
    (sem reenviar o menu inteiro, sem transferir sozinho pra ninguém —
    fica esperando o cliente digitar certo)."""
    conn.execute(
        """
        INSERT INTO whatsapp_mensagens (conversa_id, direcao, tipo, texto, externo_id, status, criado_em)
        VALUES (?, 'entrada', 'texto', ?, ?, 'recebida', ?)
        """,
        (conversa["id"], texto, externo_id, agora),
    )
    conn.execute(
        "UPDATE whatsapp_conversas SET ultima_mensagem_em = ?, ultima_mensagem_preview = ? WHERE id = ?",
        (agora, (texto or "")[:120], conversa["id"]),
    )

    config = obter_configuracao(conn, empresa_id)
    opcoes = json.loads(conversa["menu_opcoes"] or "[]")
    match = re.search(r"\d+", texto or "")

    def _responder(msg):
        try:
            enviar_texto(config, telefone, msg)
        except ApiError:
            pass

    if not match or not (1 <= int(match.group()) <= len(opcoes)):
        if conversa["menu_estado"] != "setor":
            _responder("Digite apenas o número correspondente.")
            return {"processado": True, "tipo": "menu_resposta_invalida", "conversa_id": conversa["id"]}

        tentativas = (conversa["menu_tentativas_invalidas"] or 0) + 1
        if tentativas < TENTATIVAS_MENU_ANTES_DO_FALLBACK:
            conn.execute("UPDATE whatsapp_conversas SET menu_tentativas_invalidas = ? WHERE id = ?", (tentativas, conversa["id"]))
            _responder("Digite apenas o número correspondente.")
            return {"processado": True, "tipo": "menu_resposta_invalida", "conversa_id": conversa["id"]}

        # 2ª tentativa errada — para de pedir e resolve por ele.
        _responder(f"Deixa eu te ajudar! Vou te transferir para um de nossos consultores de {SETOR_FALLBACK_PADRAO} 🙂")
        return _rotear_para_setor(conn, empresa_id, conversa, SETOR_FALLBACK_PADRAO, _responder)

    escolha = int(match.group()) - 1

    if conversa["menu_estado"] == "atendente":
        atendente = opcoes[escolha]
        atribuir_conversa(conn, conversa["id"], atendente["id"], None)
        conn.execute("UPDATE whatsapp_conversas SET menu_estado = NULL, menu_opcoes = NULL WHERE id = ?", (conversa["id"],))
        _responder(f"Você foi direcionado(a) para {atendente['nome']}. Só um momento! 😊")
        return {"processado": True, "tipo": "menu_atribuido", "conversa_id": conversa["id"]}

    setor = opcoes[escolha]
    return _rotear_para_setor(conn, empresa_id, conversa, setor, _responder)


def _tentar_capturar_avaliacao(conn, empresa_id, conversa, telefone, texto, externo_id, agora):
    """Devolve um dict de resultado se a mensagem foi capturada como
    avaliação; None se não achou uma nota válida (quem chamou deve então
    tratar a mensagem normalmente)."""
    match = re.search(r"[1-5]", texto or "")
    if not match:
        return None
    nota = int(match.group())
    comentario = ((texto or "")[:match.start()] + (texto or "")[match.end():]).strip() or None

    conn.execute(
        """
        INSERT INTO whatsapp_avaliacoes (conversa_id, usuario_id, nota, comentario, criado_em)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(conversa_id) DO UPDATE SET
            usuario_id = excluded.usuario_id, nota = excluded.nota,
            comentario = excluded.comentario, criado_em = excluded.criado_em
        """,
        (conversa["id"], conversa["atribuida_usuario_id"], nota, comentario, agora),
    )
    conn.execute("UPDATE whatsapp_conversas SET aguardando_avaliacao = 0 WHERE id = ?", (conversa["id"],))
    conn.execute(
        """
        INSERT INTO whatsapp_mensagens (conversa_id, direcao, tipo, texto, externo_id, status, criado_em)
        VALUES (?, 'entrada', 'texto', ?, ?, 'recebida', ?)
        """,
        (conversa["id"], texto, externo_id, agora),
    )
    # Agradecimento automático — melhor esforço, nunca impede a avaliação
    # de ser salva mesmo que o envio falhe (ex.: instância desconectada).
    try:
        config = obter_configuracao(conn, empresa_id)
        enviar_texto(config, telefone, "Muito obrigado pela sua avaliação! 🙏")
    except ApiError:
        pass
    return {"processado": True, "tipo": "avaliacao_recebida", "conversa_id": conversa["id"], "nota": nota}


# ============================================================
# RESPOSTAS PRONTAS
# ============================================================
def listar_respostas_prontas(conn, empresa_id: int):
    rows = conn.execute("SELECT * FROM whatsapp_respostas_prontas WHERE empresa_id = ? ORDER BY atalho", (empresa_id,)).fetchall()
    return [dict(r) for r in rows]


def criar_resposta_pronta(conn, empresa_id: int, atalho: str, titulo: str, texto: str, usuario_id: int):
    ja_existe = conn.execute("SELECT 1 FROM whatsapp_respostas_prontas WHERE empresa_id = ? AND atalho = ?", (empresa_id, atalho)).fetchone()
    if ja_existe:
        raise ApiError(f"Já existe uma resposta pronta com o atalho '{atalho}'.", status=409, codigo="atalho_duplicado")
    conn.execute(
        "INSERT INTO whatsapp_respostas_prontas (empresa_id, atalho, titulo, texto, criado_por, criado_em) VALUES (?, ?, ?, ?, ?, ?)",
        (empresa_id, atalho, titulo, texto, usuario_id, _now_iso()),
    )
    return dict(conn.execute("SELECT * FROM whatsapp_respostas_prontas WHERE empresa_id = ? AND atalho = ?", (empresa_id, atalho)).fetchone())


def excluir_resposta_pronta(conn, empresa_id: int, resposta_id: int) -> bool:
    cur = conn.execute("DELETE FROM whatsapp_respostas_prontas WHERE id = ? AND empresa_id = ?", (resposta_id, empresa_id))
    return cur.rowcount > 0


# ============================================================
# NOTAS INTERNAS (nunca enviadas ao cliente)
# ============================================================
def listar_notas(conn, conversa_id: int):
    rows = conn.execute(
        "SELECT n.*, u.nome AS usuario_nome FROM whatsapp_notas n LEFT JOIN usuarios u ON u.id = n.usuario_id "
        "WHERE n.conversa_id = ? ORDER BY n.criado_em",
        (conversa_id,),
    ).fetchall()
    return [dict(r) for r in rows]


def criar_nota(conn, conversa_id: int, usuario_id: int, texto: str):
    conn.execute(
        "INSERT INTO whatsapp_notas (conversa_id, usuario_id, texto, criado_em) VALUES (?, ?, ?, ?)",
        (conversa_id, usuario_id, texto, _now_iso()),
    )


# ============================================================
# ETIQUETAS (TAGS) LIVRES
# ============================================================
# ============================================================
# ETIQUETAS
#
# Cada etiqueta pertence a UM usuário: o que eu escrevo num cliente é
# anotação minha, e o colega que atende o mesmo cliente não vê nem é
# atrapalhado por ela. Duas pessoas podem ter uma "Urgente" cada uma,
# com cores diferentes, sem se pisarem.
#
# Como a etiqueta tem dono, a etiquetagem herda o dono junto — por isso
# as tabelas de ligação não guardam usuario_id: basta olhar de quem é a
# etiqueta. Todas as consultas abaixo filtram por t.usuario_id.
# ============================================================
def listar_tags(conn, empresa_id: int, usuario_id: int):
    return [dict(r) for r in conn.execute(
        "SELECT * FROM whatsapp_tags WHERE empresa_id = ? AND usuario_id = ? ORDER BY nome",
        (empresa_id, usuario_id),
    ).fetchall()]


def criar_tag(conn, empresa_id: int, usuario_id: int, nome: str, cor: str):
    ja_existe = conn.execute(
        "SELECT 1 FROM whatsapp_tags WHERE empresa_id = ? AND usuario_id = ? AND lower(nome) = lower(?)",
        (empresa_id, usuario_id, nome),
    ).fetchone()
    if ja_existe:
        raise ApiError(f"Você já tem uma etiqueta '{nome}'.", status=409, codigo="tag_duplicada")
    conn.execute(
        "INSERT INTO whatsapp_tags (empresa_id, usuario_id, nome, cor) VALUES (?, ?, ?, ?)",
        (empresa_id, usuario_id, nome, cor or "#6b7280"),
    )
    return dict(conn.execute(
        "SELECT * FROM whatsapp_tags WHERE empresa_id = ? AND usuario_id = ? AND nome = ?",
        (empresa_id, usuario_id, nome),
    ).fetchone())


def excluir_tag(conn, empresa_id: int, usuario_id: int, tag_id: int) -> bool:
    dona = conn.execute(
        "SELECT 1 FROM whatsapp_tags WHERE id = ? AND empresa_id = ? AND usuario_id = ?",
        (tag_id, empresa_id, usuario_id),
    ).fetchone()
    if dona is None:
        return False
    conn.execute("DELETE FROM whatsapp_conversa_tags WHERE tag_id = ?", (tag_id,))
    conn.execute("DELETE FROM chat_interno_conversa_tags WHERE tag_id = ?", (tag_id,))
    cur = conn.execute("DELETE FROM whatsapp_tags WHERE id = ?", (tag_id,))
    return cur.rowcount > 0


def definir_tags_da_conversa(conn, empresa_id: int, usuario_id: int, conversa_id: int, tag_ids: list):
    """Apaga só as MINHAS etiquetagens desta conversa antes de regravar —
    as que o colega pôs continuam intactas, ele nem fica sabendo."""
    conn.execute(
        "DELETE FROM whatsapp_conversa_tags WHERE conversa_id = ? AND tag_id IN "
        "(SELECT id FROM whatsapp_tags WHERE usuario_id = ?)",
        (conversa_id, usuario_id),
    )
    for tid in tag_ids:
        conn.execute(
            "INSERT INTO whatsapp_conversa_tags (conversa_id, tag_id) "
            "SELECT ?, id FROM whatsapp_tags WHERE id = ? AND empresa_id = ? AND usuario_id = ?",
            (conversa_id, tid, empresa_id, usuario_id),
        )


def tags_por_conversa(conn, conversa_ids: list, usuario_id: int):
    """Etiquetas de várias conversas de uma vez (evita uma consulta por
    linha da lista). Traz só as do usuário que está olhando."""
    if not conversa_ids:
        return {}
    marcadores = ",".join("?" * len(conversa_ids))
    rows = conn.execute(
        f"SELECT ct.conversa_id, t.id, t.nome, t.cor FROM whatsapp_conversa_tags ct "
        f"JOIN whatsapp_tags t ON t.id = ct.tag_id "
        f"WHERE ct.conversa_id IN ({marcadores}) AND t.usuario_id = ? ORDER BY t.nome",
        list(conversa_ids) + [usuario_id],
    ).fetchall()
    resultado = {}
    for r in rows:
        resultado.setdefault(r["conversa_id"], []).append({"id": r["id"], "nome": r["nome"], "cor": r["cor"]})
    return resultado


# ============================================================
# ALERTA DE SLA — conversa parada há tempo demais sem resposta nossa
# ============================================================
def listar_conversas_sla_estourado(conn, empresa_id: int, usuario_id=None, setor=None):
    config = obter_configuracao(conn, empresa_id)
    limite_min = config.get("sla_minutos_alerta") or 15
    limite = (datetime.datetime.utcnow() - datetime.timedelta(minutes=limite_min)).strftime("%Y-%m-%dT%H:%M:%S.%fZ")
    condicoes = [
        "ct.empresa_id = ?",
        "c.status = 'aberta'", "c.excluida_em IS NULL", "c.arquivada = 0",
        "c.ultima_mensagem_em IS NOT NULL", "c.ultima_mensagem_em < ?",
        "(c.atribuida_usuario_id IS NULL OR (SELECT m.direcao FROM whatsapp_mensagens m "
        "WHERE m.conversa_id = c.id ORDER BY m.criado_em DESC, m.id DESC LIMIT 1) = 'entrada')",
        # Marcada como "não precisa responder" DEPOIS da última mensagem:
        # sai do alerta. A comparação com a data da última mensagem é o
        # que faz a marca se desfazer sozinha quando o cliente fala de
        # novo — aí é pendência nova, e o alerta volta a valer.
        "(c.sem_pendencia_em IS NULL OR c.sem_pendencia_em < c.ultima_mensagem_em)",
    ]
    params = [empresa_id, limite]
    if usuario_id:
        # Mesma régua de visibilidade do resto do sistema: a dele, mais
        # as da fila do setor dele (nunca as de outro setor).
        condicoes.append(
            "(c.atribuida_usuario_id = ? OR (c.atribuida_usuario_id IS NULL AND c.menu_setor IS NOT NULL AND c.menu_setor = ?))"
        )
        params.extend([usuario_id, setor])
    where = "WHERE " + " AND ".join(condicoes)
    rows = conn.execute(
        f"""
        SELECT c.*, ct.telefone, ct.nome AS contato_nome, u.nome AS atribuida_usuario_nome
        FROM whatsapp_conversas c
        JOIN whatsapp_contatos ct ON ct.id = c.contato_id
        LEFT JOIN usuarios u ON u.id = c.atribuida_usuario_id
        {where} ORDER BY c.ultima_mensagem_em
        """,
        params,
    ).fetchall()
    return [dict(r) for r in rows]
