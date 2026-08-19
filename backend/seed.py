"""
Cria o primeiro usuário administrador. Rode uma única vez após criar o
schema (init_db):

    python seed.py

A senha é lida de WPP_ADMIN_SENHA; se não for definida, uma senha
aleatória forte é gerada e impressa uma única vez no terminal.
"""
import datetime
import os
import secrets
import string
import sys

from app import db as db_module
from app import security


def _now_iso():
    return datetime.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def _gerar_senha_forte(tamanho=16):
    alfabeto = string.ascii_letters + string.digits
    while True:
        senha = "".join(secrets.choice(alfabeto) for _ in range(tamanho))
        if not security.validar_politica_senha(senha):
            return senha


def rodar_seed(conn=None, admin_email=None, admin_senha=None, imprimir=True):
    proprio_conn = conn is None
    if proprio_conn:
        conn = db_module._connect()

    email = (admin_email or os.environ.get("WPP_ADMIN_EMAIL") or "admin@whatts.local").strip().lower()
    ja_existe = conn.execute("SELECT id FROM usuarios WHERE email = ?", (email,)).fetchone()

    senha_gerada = None
    if not ja_existe:
        senha = admin_senha or os.environ.get("WPP_ADMIN_SENHA")
        if not senha:
            senha = _gerar_senha_forte()
            senha_gerada = senha
        conn.execute(
            "INSERT INTO usuarios (nome, email, senha_hash, admin, ativo, criado_em) VALUES (?, ?, ?, 1, 1, ?)",
            ("Administrador", email, security.hash_password(senha), _now_iso()),
        )
        conn.commit()
        if imprimir:
            print(f"Usuário administrador criado: {email}")
            if senha_gerada:
                print(f"Senha gerada (guarde agora, não será mostrada de novo): {senha_gerada}")
    elif imprimir:
        print(f"Usuário administrador já existia: {email}")

    if proprio_conn:
        conn.close()
    return {"email": email, "senha_gerada": senha_gerada}


if __name__ == "__main__":
    if not os.path.exists(db_module.get_db_path()):
        db_module.init_db()
    rodar_seed()
