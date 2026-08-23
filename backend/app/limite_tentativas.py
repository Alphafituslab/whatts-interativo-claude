"""
Freio contra tentativa de adivinhar senha (força bruta) no login.

Sem isso, qualquer um na internet pode disparar milhares de senhas por
minuto contra o /auth/login — o sistema está num endereço público, então
isso deixou de ser hipótese. Vale também pro código de 2 fatores, que só
tem 6 dígitos e seria trivial de varrer sem limite.

Contagem em memória do próprio processo, de propósito: o servidor roda
num processo só (waitress), não precisa de Redis nem tabela nova, e o
custo de reiniciar (zerar as contagens) é irrelevante — reiniciar é raro
e não dá vantagem prática pra quem ataca.

Duas chaves ao mesmo tempo:
  - por IP    -> impede varrer muitas senhas de um lugar só
  - por conta -> impede varrer a mesma conta a partir de vários IPs
"""
import threading
import time

# Janela e limites: 10 erros em 15 min bloqueiam por 15 min. Folga
# suficiente pra quem só errou a senha algumas vezes, apertado demais pra
# quem está tentando adivinhar.
JANELA_SEGUNDOS = 15 * 60
MAX_FALHAS = 10
BLOQUEIO_SEGUNDOS = 15 * 60

_lock = threading.Lock()
_falhas = {}  # chave -> [instantes das falhas recentes]
_bloqueios = {}  # chave -> instante em que o bloqueio termina


def _limpar(agora):
    """Descarta o que já passou da janela — sem isso o dicionário só
    cresce enquanto o processo vive."""
    for chave in list(_falhas):
        _falhas[chave] = [t for t in _falhas[chave] if agora - t < JANELA_SEGUNDOS]
        if not _falhas[chave]:
            del _falhas[chave]
    for chave in list(_bloqueios):
        if _bloqueios[chave] <= agora:
            del _bloqueios[chave]


def segundos_restantes(chaves):
    """0 = liberado. Maior que 0 = quantos segundos ainda faltam pra
    poder tentar de novo."""
    agora = time.time()
    with _lock:
        _limpar(agora)
        restantes = [int(_bloqueios[c] - agora) for c in chaves if c in _bloqueios]
    return max(restantes) if restantes else 0


def registrar_falha(chaves):
    """Conta mais um erro. Ao passar do limite, bloqueia aquela chave."""
    agora = time.time()
    with _lock:
        _limpar(agora)
        for chave in chaves:
            _falhas.setdefault(chave, []).append(agora)
            if len(_falhas[chave]) >= MAX_FALHAS:
                _bloqueios[chave] = agora + BLOQUEIO_SEGUNDOS
                _falhas.pop(chave, None)


def registrar_sucesso(chaves):
    """Login certo zera o histórico — quem errou algumas vezes e acertou
    não fica com o contador pela metade pro resto do dia."""
    with _lock:
        for chave in chaves:
            _falhas.pop(chave, None)
            _bloqueios.pop(chave, None)
