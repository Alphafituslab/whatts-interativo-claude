"""
Transcrição de áudio — ler em vez de ouvir.

Roda NO PRÓPRIO SERVIDOR, com o Whisper (via faster-whisper). Foi uma
escolha deliberada: mandar o áudio para uma API de fora seria mais
rápido de montar, mas o que os clientes falam sairia da empresa e
passaria a custar por minuto transcrito. Aqui não sai nada e não custa
nada por uso.

O preço disso é tempo de processador: o servidor tem 2 núcleos e nenhuma
placa de vídeo, então um áudio de um minuto leva alguns segundos. Por
isso a transcrição é SOB DEMANDA (alguém clica) e fica guardada no banco
— o segundo que abrir a conversa já lê pronto.
"""
import datetime
import os
import threading

# Modelo pequeno de propósito. O "small" acerta um pouco mais, mas ocupa
# perto de 1 GB de memória e o servidor tem 4 GB dividido com o resto do
# sistema. O "base" com quantização int8 dá conta de português de
# conversa gastando bem menos.
MODELO = os.environ.get("WPP_MODELO_TRANSCRICAO", "base")

# Áudio muito longo trava um núcleo por tempo demais. Acima disto,
# transcreve só o começo e avisa na tela.
SEGUNDOS_MAXIMOS = int(os.environ.get("WPP_MAX_SEGUNDOS_AUDIO", "300"))

_modelo = None
_trava = threading.Lock()


class TranscricaoIndisponivel(Exception):
    """O servidor não tem (ou não conseguiu carregar) o transcritor."""


def _obter_modelo():
    """Carrega o modelo uma única vez, na primeira transcrição.

    Fora do arranque do servidor de propósito: carregar custa memória e
    alguns segundos, e numa instalação que nunca transcreve nada isso
    seria desperdício puro.
    """
    global _modelo
    if _modelo is not None:
        return _modelo
    with _trava:
        if _modelo is not None:
            return _modelo
        try:
            from faster_whisper import WhisperModel
        except ImportError as e:
            raise TranscricaoIndisponivel(
                "O transcritor de áudio não está instalado neste servidor."
            ) from e
        _modelo = WhisperModel(MODELO, device="cpu", compute_type="int8")
        return _modelo


def disponivel() -> bool:
    """Sem carregar o modelo — só diz se a biblioteca existe. A tela usa
    isso pra não oferecer um botão que vai falhar."""
    try:
        import faster_whisper  # noqa: F401
        return True
    except ImportError:
        return False


# Mensagens cuja transcrição já foi disparada e ainda não terminou --
# evita clicar duas vezes (ou dois admins ao mesmo tempo) disparando
# DUAS transcrições da mesma mensagem, gastando o único núcleo à toa.
_em_andamento = set()
_trava_em_andamento = threading.Lock()


def transcrever_em_segundo_plano(mensagem_id: int, tabela: str, caminho_audio: str):
    """Dispara a transcrição numa thread separada e devolve na hora --
    quem chamou NÃO espera terminar.

    Existe porque o servidor tem só 1 CPU: transcrever de forma
    bloqueante (como era antes) travava o processo inteiro -- todo
    mundo, em qualquer tela, sentia lentidão ou a tela nem abrir --
    pelo tempo inteiro que durava a transcrição de UM áudio.

    `tabela` é 'whatsapp_mensagens' ou 'chat_interno_mensagens' -- as
    duas têm as mesmas colunas transcricao/transcricao_em. A tela
    continua enxergando o resultado do jeito de sempre: o polling que
    já existe (a cada poucos segundos) troca o botão pela transcrição
    pronta assim que ela terminar, sem precisar de nada novo no
    front-end.

    Devolve True se disparou agora, False se essa mensagem já estava
    sendo transcrita (nesse caso não faz nada -- só espera a que já
    está rodando)."""
    with _trava_em_andamento:
        if mensagem_id in _em_andamento:
            return False
        _em_andamento.add(mensagem_id)

    def _trabalhar():
        from . import db as db_module
        conn = db_module._connect()
        try:
            try:
                texto = transcrever(caminho_audio)
            except Exception:
                # Falhou (áudio corrompido, sem modelo etc.) -- não deixa
                # a mensagem presa em "transcrevendo" pra sempre; grava
                # vazio, e o botão de tentar de novo aparece pra quem
                # quiser tentar (transcricao_em preenchido = tentativa
                # concluída, mesmo que sem texto).
                texto = None
            if texto is not None:
                conn.execute(
                    f"UPDATE {tabela} SET transcricao = ?, transcricao_em = ? WHERE id = ?",
                    (texto, datetime.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%S.%fZ"), mensagem_id),
                )
                conn.commit()
        finally:
            conn.close()
            with _trava_em_andamento:
                _em_andamento.discard(mensagem_id)

    threading.Thread(target=_trabalhar, daemon=True).start()
    return True


def transcrever(caminho_audio: str) -> str:
    """Devolve o texto falado no áudio. Texto vazio = não deu pra
    entender nada (áudio mudo, só ruído), que é diferente de erro."""
    if not os.path.exists(caminho_audio):
        raise FileNotFoundError(caminho_audio)

    modelo = _obter_modelo()
    # Uma transcrição por vez: são dois núcleos, e duas ao mesmo tempo
    # deixariam o atendimento lento pra todo mundo.
    with _trava:
        segmentos, _info = modelo.transcribe(
            caminho_audio,
            language="pt",
            beam_size=1,          # mais rápido; a diferença de acerto é pequena
            vad_filter=True,      # corta os silêncios, que é onde ele costuma inventar texto
            vad_parameters={"min_silence_duration_ms": 500},
        )
        partes, duracao = [], 0.0
        for s in segmentos:
            partes.append(s.text.strip())
            duracao = s.end
            if duracao >= SEGUNDOS_MAXIMOS:
                partes.append("[…áudio longo: transcrito só o começo]")
                break
    return " ".join(p for p in partes if p).strip()
