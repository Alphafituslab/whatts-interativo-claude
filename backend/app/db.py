"""
Conexão e utilitários de banco de dados (SQLite).

As migrations são aplicadas em ordem e de forma incremental: uma tabela de
controle `_migrations` registra o que já foi aplicado, para que atualizar
para uma versão nova nunca apague ou recrie o que já existe.
"""
import os
import sqlite3

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_DB_PATH = os.path.join(BASE_DIR, "data", "whatsapp.db")
MIGRATIONS_DIR = os.path.join(BASE_DIR, "migrations")

SCHEMA_FILES = [
    "schema.sql",
    "schema_002_atribuicao_dashboard.sql",
    "schema_003_resumo_agenda_lembrete.sql",
    "schema_004_avaliacao.sql",
    "schema_005_webhook_auto_auditoria.sql",
    "schema_006_setor_presenca_menu.sql",
    "schema_007_consultoria.sql",
    "schema_008_regioes_resultado.sql",
    "schema_009_usuario_offline_forcado.sql",
    "schema_010_foto_contato.sql",
    "schema_011_agendada_midia.sql",
    "schema_012_chat_interno.sql",
    "schema_013_multi_empresa.sql",
    "schema_014_saudacao_editavel.sql",
    "schema_015_digitando.sql",
    "schema_016_menu_tentativas.sql",
    "schema_017_setores_configuraveis.sql",
    "schema_018_apelidos.sql",
    "schema_019_dashboard_reset.sql",
]


def get_db_path():
    return os.environ.get("WPP_DB_PATH", DEFAULT_DB_PATH)


def _connect(db_path=None):
    path = db_path or get_db_path()
    os.makedirs(os.path.dirname(path), exist_ok=True)
    conn = sqlite3.connect(path, detect_types=sqlite3.PARSE_DECLTYPES)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db(db_path=None):
    conn = _connect(db_path)
    try:
        conn.execute(
            "CREATE TABLE IF NOT EXISTS _migrations (arquivo TEXT PRIMARY KEY, aplicado_em TEXT NOT NULL DEFAULT (datetime('now')))"
        )
        conn.commit()
        for arquivo in SCHEMA_FILES:
            ja_aplicado = conn.execute("SELECT 1 FROM _migrations WHERE arquivo = ?", (arquivo,)).fetchone()
            if ja_aplicado:
                continue
            caminho = os.path.join(MIGRATIONS_DIR, arquivo)
            with open(caminho, "r", encoding="utf-8") as f:
                sql = f.read()
            conn.executescript(sql)
            conn.execute("INSERT INTO _migrations (arquivo) VALUES (?)", (arquivo,))
            conn.commit()
    finally:
        conn.close()
