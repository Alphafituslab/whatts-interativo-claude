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
import zipfile

from . import db as db_module

# Nomes esperados dentro de uma pasta/zip de backup — usados tanto pra
# gerar quanto pra validar um zip importado antes de restaurar (evita
# aceitar um arquivo qualquer que não seja mesmo um backup nosso).
NOME_ARQUIVO_DB = "whatsapp.db"

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
    # microssegundos no nome — sem isso, dois backups no mesmo segundo
    # (ex.: o backup de segurança automático rodando logo antes de uma
    # restauração) colidem na mesma pasta e um sobrescreve o outro,
    # cancelando a restauração em silêncio (achado testando).
    agora = datetime.datetime.now().strftime("%Y-%m-%d_%H-%M-%S-%f")
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


def caminho_backup(nome: str):
    """os.path.basename corta qualquer '../' — nome vem de fora (URL/
    upload), nunca confiar nele sem sanitizar antes de montar um caminho
    de arquivo real no disco."""
    pasta = os.path.join(_pasta_backups(), os.path.basename(nome))
    if not os.path.isdir(pasta) or not os.path.isfile(os.path.join(pasta, NOME_ARQUIVO_DB)):
        return None
    return pasta


def zipar_backup(nome: str):
    """Empacota a pasta de um backup num único .zip em memória, pra
    poder ser baixado como um arquivo (cópia fora do servidor)."""
    import io
    pasta = caminho_backup(nome)
    if pasta is None:
        raise FileNotFoundError(nome)
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as zf:
        for raiz, _dirs, arquivos in os.walk(pasta):
            for arq in arquivos:
                caminho_completo = os.path.join(raiz, arq)
                caminho_no_zip = os.path.relpath(caminho_completo, pasta)
                zf.write(caminho_completo, caminho_no_zip)
    buffer.seek(0)
    return buffer


def _restaurar_pasta(pasta_origem):
    """Núcleo comum: substitui o banco e os arquivos ATUAIS pelo
    conteúdo de `pasta_origem` (uma pasta de backup já extraída/
    descompactada). Sempre faz um backup do estado atual ANTES de
    sobrescrever — se a restauração foi um engano, dá pra desfazer
    restaurando esse backup de segurança logo em seguida.

    Usa a API de backup do próprio SQLite (Connection.backup) em vez de
    copiar o arquivo .db por cima — funciona mesmo com o banco em uso
    por outras conexões (o servidor não precisa parar), do mesmo jeito
    que executar_backup() já faz no sentido contrário."""
    executar_backup()  # rede de segurança antes de qualquer coisa

    origem_db = os.path.join(pasta_origem, NOME_ARQUIVO_DB)
    origem_conn = sqlite3.connect(origem_db)
    try:
        destino_conn = sqlite3.connect(db_module.get_db_path())
        try:
            origem_conn.backup(destino_conn)
        finally:
            destino_conn.close()
    finally:
        origem_conn.close()

    for pasta_origem_sub, pasta_destino in (
        (os.path.join(pasta_origem, "uploads"), _pasta_uploads()),
        (os.path.join(pasta_origem, "fotos_perfil"), _pasta_fotos()),
    ):
        if os.path.isdir(pasta_origem_sub):
            if os.path.isdir(pasta_destino):
                shutil.rmtree(pasta_destino)
            shutil.copytree(pasta_origem_sub, pasta_destino)


def restaurar_backup(nome: str):
    """Restaura a partir de um backup que já existe na pasta backups/
    (a lista que aparece em Configuração)."""
    pasta = caminho_backup(nome)
    if pasta is None:
        raise FileNotFoundError(nome)
    _restaurar_pasta(pasta)


def importar_e_restaurar(origem_zip):
    """Restaura a partir de um .zip enviado pelo admin (baixado antes
    daqui mesmo, ou copiado de outra máquina) — pro caso de recuperar um
    backup quando a pasta backups/ original não está mais disponível
    (ex.: trocou de computador, formatou, etc.). origem_zip aceita tanto
    um caminho de arquivo quanto um objeto tipo-arquivo (ex.: o stream
    de um upload) — zipfile.ZipFile lida com os dois."""
    pasta_temp = os.path.join(_pasta_backups(), "_importando_temp")
    if os.path.isdir(pasta_temp):
        shutil.rmtree(pasta_temp)
    os.makedirs(pasta_temp)
    try:
        with zipfile.ZipFile(origem_zip, "r") as zf:
            zf.extractall(pasta_temp)
        if not os.path.isfile(os.path.join(pasta_temp, NOME_ARQUIVO_DB)):
            raise ValueError("Esse arquivo não parece ser um backup válido do Seja Alpha (faltando whatsapp.db).")
        _restaurar_pasta(pasta_temp)
    finally:
        shutil.rmtree(pasta_temp, ignore_errors=True)


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
