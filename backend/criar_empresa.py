"""
Cadastra uma empresa nova (cliente que comprou o sistema) e o primeiro
usuário administrador dela — cada empresa fica com dados 100% isolados
(usuários, contatos, conversas, tags, respostas prontas, chat interno,
configuração de WhatsApp), mesmo compartilhando o mesmo banco de dados.

Uso:
    python criar_empresa.py "Nome da Empresa" admin@empresa.com [dominio.da.empresa.com.br]

O domínio é opcional (dá pra cadastrar depois, direto no banco), mas sem
ele a tela de login desta empresa mostra a logo padrão até alguém
configurar. Lembre de criar o bloco correspondente no Caddyfile e apontar
o DNS do cliente pra este servidor — isso ainda é feito à mão.

A senha é lida de WPP_NOVA_EMPRESA_SENHA; se não for definida, uma senha
aleatória forte é gerada e impressa uma única vez no terminal.

Depois de criada, a instância Evolution API (WhatsApp) dela ainda precisa
ser provisionada à parte (Docker) — o admin novo entra em Configuração e
preenche a URL/chave/nome da instância dele, exatamente como já é feito
hoje pra empresa existente.
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


# Ponto de partida — a empresa edita livremente depois (criar, renomear,
# excluir) em Configuração > Setores.
SETORES_PADRAO = [
    "Televendas", "Financeiro", "Faturamento", "Compras", "RH", "PCP",
    "Almoxarifado", "Laboratório", "Microbiológico", "Marketing", "Controladoria",
]


def criar_empresa(nome_empresa: str, admin_email: str, admin_senha: str = None, dominio: str = None, conn=None, imprimir=True):
    proprio_conn = conn is None
    if proprio_conn:
        conn = db_module._connect()

    email = admin_email.strip().lower()
    ja_existe = conn.execute("SELECT id FROM usuarios WHERE email = ?", (email,)).fetchone()
    if ja_existe:
        raise SystemExit(f"Já existe um usuário com o email {email} (email é único em todo o sistema, mesmo entre empresas diferentes).")

    dominio = (dominio or "").strip().lower() or None
    if dominio:
        conflito = conn.execute("SELECT id FROM empresas WHERE dominio = ?", (dominio,)).fetchone()
        if conflito:
            raise SystemExit(f"O domínio {dominio} já está em uso por outra empresa.")

    cur = conn.execute(
        "INSERT INTO empresas (nome, ativo, criado_em, dominio) VALUES (?, 1, ?, ?)",
        (nome_empresa.strip(), _now_iso(), dominio),
    )
    empresa_id = cur.lastrowid

    senha_gerada = None
    senha = admin_senha or os.environ.get("WPP_NOVA_EMPRESA_SENHA")
    if not senha:
        senha = _gerar_senha_forte()
        senha_gerada = senha

    conn.execute(
        "INSERT INTO usuarios (nome, email, senha_hash, admin, ativo, criado_em, empresa_id) VALUES (?, ?, ?, 1, 1, ?, ?)",
        ("Administrador", email, security.hash_password(senha), _now_iso(), empresa_id),
    )
    for i, nome_setor in enumerate(SETORES_PADRAO):
        conn.execute(
            "INSERT INTO whatsapp_setores (empresa_id, nome, ordem, criado_em) VALUES (?, ?, ?, ?)",
            (empresa_id, nome_setor, i, _now_iso()),
        )
    conn.commit()

    if imprimir:
        print(f"Empresa criada: {nome_empresa} (id {empresa_id})")
        print(f"Usuário administrador: {email}")
        if senha_gerada:
            print(f"Senha gerada (guarde agora, não será mostrada de novo): {senha_gerada}")
        if dominio:
            print(f"Domínio: {dominio} — falta criar o bloco no Caddyfile e apontar o DNS do cliente pra este servidor.")
        else:
            print("Sem domínio próprio ainda: a tela de login dela usa a logo padrão até alguém preencher o campo `dominio` na tabela `empresas`.")
        print("Agora é só logar com esse email/senha e preencher a Configuração do WhatsApp (URL/chave/instância da Evolution API dela).")

    if proprio_conn:
        conn.close()
    return {"empresa_id": empresa_id, "email": email, "senha_gerada": senha_gerada}


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Uso: python criar_empresa.py \"Nome da Empresa\" admin@empresa.com [dominio.da.empresa.com.br]")
        sys.exit(1)
    if not os.path.exists(db_module.get_db_path()):
        db_module.init_db()
    criar_empresa(sys.argv[1], sys.argv[2], dominio=(sys.argv[3] if len(sys.argv) > 3 else None))
