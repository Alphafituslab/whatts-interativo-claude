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
