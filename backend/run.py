"""
Ponto de entrada para desenvolvimento/local. Em produção, use waitress
(ver README.md).
"""
import os

from app import backup, create_app
from app import db as db_module
from app import scheduler

if not os.path.exists(db_module.get_db_path()):
    print(f"Banco não encontrado em {db_module.get_db_path()}. Criando schema...")
    db_module.init_db()
    print("Schema criado. Rode 'python seed.py' antes do primeiro uso, se ainda não rodou.")
else:
    db_module.init_db()

app = create_app()
scheduler.iniciar_agendador_em_background()
backup.iniciar_backup_em_background()

if __name__ == "__main__":
    if not os.environ.get("WPP_JWT_SECRET"):
        raise SystemExit(
            "Defina a variável de ambiente WPP_JWT_SECRET antes de iniciar "
            "(ex.: export WPP_JWT_SECRET=$(python -c \"import secrets;print(secrets.token_hex(32))\"))"
        )
    # 0.0.0.0 — escuta em todas as interfaces de rede (não só localhost),
    # pra outros computadores da mesma rede local conseguirem acessar,
    # não só esta máquina. waitress em vez do servidor de desenvolvimento
    # do Flask porque agora é uso real com várias pessoas ao mesmo tempo,
    # não só um teste local — é o mesmo servidor que o README já indicava
    # pra produção.
    from waitress import serve
    print("Whatts Inbox rodando em http://0.0.0.0:5050 (acessível pela rede local)")
    serve(app, host="0.0.0.0", port=5050)
