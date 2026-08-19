"""
Backup automático em segundo plano — copia o banco (whatsapp.db) e a
pasta de uploads (anexos + fotos de perfil) pra data/backups/, uma vez
por dia, mantendo só os últimos DIAS_MANTIDOS backups (o mais antigo é
apagado a cada rodada nova).

Roda numa thread daemon, mesmo padrão do scheduler.py — inicia com o
processo, sem travar o servidor esperando o backup terminar.

Usa sqlite3.Connection.backup() em vez de copiar o arquivo .db direto:
copiar bytes de um SQLite que pode estar com uma escrita em andamento
arrisca gerar uma cópia corrompida; a API de backup do próprio SQLite
lida com isso de forma segura, consistente mesmo com o banco em uso.
"""
import datetime
import os
import shutil
import sqlite3
import threading
import time
import traceback

from . import db as db_module

INTERVALO_SEGUNDOS = 6 * 60 * 60  # confere a cada 6h se já passou 1 dia do último backup
DIAS_MANTIDOS = 14
_thread_iniciada = False


def _pasta_backups():
    base = os.path.dirname(db_module.get_db_path())
    pasta = os.path.join(base, "backups")
    os.makedirs(pasta, exist_ok=True)
    return pasta


def _pasta_uploads():
    base = os.path.dirname(db_module.get_db_path())
    return os.path.join(base, "uploads")


def _pasta_fotos():
    base = os.path.dirname(db_module.get_db_path())
    return os.path.join(base, "fotos_perfil")


def executar_backup():
    """Faz um backup agora (chamado pela thread periódica, e também
    exposto pra rota manual 'Fazer backup agora' em Configuração)."""
    pasta_backups = _pasta_backups()
    agora = datetime.datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
    pasta_este = os.path.join(pasta_backups, agora)
    os.makedirs(pasta_este, exist_ok=True)

    origem = sqlite3.connect(db_module.get_db_path())
    try:
        destino = sqlite3.connect(os.path.join(pasta_este, "whatsapp.db"))
        try:
            origem.backup(destino)
        finally:
            destino.close()
    finally:
        origem.close()

    for pasta_origem, nome in ((_pasta_uploads(), "uploads"), (_pasta_fotos(), "fotos_perfil")):
        if os.path.isdir(pasta_origem):
            shutil.copytree(pasta_origem, os.path.join(pasta_este, nome))

    _rotacionar(pasta_backups)
    return pasta_este


def _rotacionar(pasta_backups):
    entradas = sorted(
        (e for e in os.listdir(pasta_backups) if os.path.isdir(os.path.join(pasta_backups, e))),
        reverse=True,
    )
    for antiga in entradas[DIAS_MANTIDOS:]:
        shutil.rmtree(os.path.join(pasta_backups, antiga), ignore_errors=True)


def _ja_fez_backup_hoje(pasta_backups):
    hoje = datetime.datetime.now().strftime("%Y-%m-%d")
    return any(e.startswith(hoje) for e in os.listdir(pasta_backups))


def _loop():
    while True:
        try:
            pasta_backups = _pasta_backups()
            if not _ja_fez_backup_hoje(pasta_backups):
                executar_backup()
        except Exception:
            # Backup é justamente a rede de segurança — se ele quebrar
            # em silêncio, ninguém percebe até precisar restaurar algo
            # e descobrir que não tem backup nenhum. Loga sempre.
            print("[backup] erro ao executar backup automático:")
            traceback.print_exc()
        time.sleep(INTERVALO_SEGUNDOS)


def iniciar_backup_em_background():
    global _thread_iniciada
    if _thread_iniciada:
        return
    _thread_iniciada = True
    t = threading.Thread(target=_loop, daemon=True, name="whatts-backup")
    t.start()
