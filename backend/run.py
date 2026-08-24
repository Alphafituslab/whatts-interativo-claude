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
    # Onde escutar:
    #   0.0.0.0   = toda a rede (uso em rede local, sem proxy na frente)
    #   127.0.0.1 = só a própria máquina — é o certo quando tem um proxy
    #               com HTTPS na frente (Caddy/nginx), porque aí ninguém
    #               alcança o app em texto puro nem se o firewall falhar.
    # Configurável por WPP_HOST pra não precisar editar código conforme
    # o ambiente (na VPS o systemd define 127.0.0.1).
    # waitress em vez do servidor de desenvolvimento do Flask porque é
    # uso real com várias pessoas ao mesmo tempo — é o mesmo servidor que
    # o README já indicava pra produção.
    from waitress import serve
    host = os.environ.get("WPP_HOST", "0.0.0.0")
    porta = int(os.environ.get("WPP_PORT", "5050"))
    print(f"Seja Alpha rodando em http://{host}:{porta}")
    serve(app, host=host, port=porta)
