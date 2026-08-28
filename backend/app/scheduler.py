"""
Agendador em segundo plano — só faz uma coisa: a cada 30 segundos, olha
se alguma mensagem agendada já venceu e manda de verdade (ver
whatsapp_service.processar_agendadas_vencidas).

Roda numa thread daemon separada da thread que atende requisições HTTP —
mesma ideia de qualquer agendador simples em background: o processo
Python continua vivo enquanto o servidor estiver no ar, então a thread
também fica. `daemon=True` garante que ela não impede o processo de
encerrar quando o servidor para.

Deliberadamente iniciado em run.py (não em app/__init__.py::create_app):
se estivesse dentro de create_app(), cada teste automatizado que chama
create_app() abriria uma thread nova, vazando threads à toa.
"""
import threading
import time
import traceback

from . import db as db_module
from . import whatsapp_service

INTERVALO_SEGUNDOS = 30
# Encerrar conversa parada é bem mais raro/caro que checar agendadas —
# não precisa rodar a cada 30s. 1x por hora (120 voltas de 30s) já
# sobra pra pegar qualquer uma que passou dos 30 dias.
VOLTAS_ATE_ENCERRAR_PARADAS = 120
_thread_iniciada = False


def _loop():
    voltas = 0
    while True:
        try:
            conn = db_module._connect()
            try:
                whatsapp_service.processar_agendadas_vencidas(conn)
                voltas += 1
                if voltas >= VOLTAS_ATE_ENCERRAR_PARADAS:
                    voltas = 0
                    whatsapp_service.encerrar_conversas_paradas(conn)
                conn.commit()
            finally:
                conn.close()
        except Exception:
            # Próxima rodada tenta de novo — nunca derruba a thread — mas o
            # erro precisa aparecer no log do servidor, senão mensagens
            # agendadas param de sair silenciosamente e ninguém percebe.
            print("[agendador] erro ao processar mensagens agendadas:")
            traceback.print_exc()
        time.sleep(INTERVALO_SEGUNDOS)


def iniciar_agendador_em_background():
    global _thread_iniciada
    if _thread_iniciada:
        return
    _thread_iniciada = True
    t = threading.Thread(target=_loop, daemon=True, name="whatts-agendador")
    t.start()
