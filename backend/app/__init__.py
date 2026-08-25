import datetime
import logging
import os
import secrets

from flask import Flask, jsonify, redirect, send_from_directory

from .context import ApiError, close_db

FRONTEND_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "..", "frontend")
FRONTEND_DIR = os.path.abspath(FRONTEND_DIR)
# Muda a cada vez que o processo sobe (cada atualização/restart do
# backend). O frontend fica de olho nisso (ver GET /api/v1/versao) pra
# saber quando uma versão nova subiu e forçar todo mundo a logar de novo
# — garante que ninguém fique preso rodando o app.js antigo em cache.
#
# É a data e a hora da atualização, só com números: além de mudar a cada
# subida (que é o que o mecanismo precisa), dá pra bater o olho e saber
# de quando é a versão que está rodando. Antes era um código
# hexadecimal, cheio de letras e sem significado nenhum pra quem lê.
# Os segundos entram pra duas subidas no mesmo minuto não gerarem o
# mesmo número — aí ninguém seria avisado da segunda.
def _numero_da_versao() -> str:
    """Data e hora da subida, no horário de Brasília.

    O resto do sistema guarda tudo em UTC (e o frontend converte), mas
    aqui é um rótulo pra ler direto na tela: em UTC ele mostraria três
    horas à frente do relógio de quem está olhando, o que confunde mais
    do que ajuda. Se o servidor não tiver a base de fusos instalada,
    cai pra UTC em vez de quebrar."""
    try:
        from zoneinfo import ZoneInfo
        agora = datetime.datetime.now(ZoneInfo("America/Sao_Paulo"))
    except Exception:
        agora = datetime.datetime.now(datetime.timezone.utc)
    return agora.strftime("%Y.%m.%d.%H%M%S")


VERSAO_SERVIDOR = _numero_da_versao()


def create_app(test_config: dict = None) -> Flask:
    app = Flask(
        __name__,
        static_folder=os.path.join(FRONTEND_DIR, "static"),
        static_url_path="/static",
    )
    app.config["MAX_CONTENT_LENGTH"] = 40 * 1024 * 1024  # 40MB — folga sobre o limite de 35MB de anexo (ver routes/whatsapp.py)
    # Sem isso o navegador cacheia app.js/styles.css "pra sempre" e quem já
    # tinha a aba aberta (ou nunca deu Ctrl+F5) fica preso numa versão
    # antiga do front-end mesmo depois do servidor já ter a mudança nova —
    # foi exatamente o que aconteceu com o botão de conectar por número.
    # max_age=0 força o navegador a sempre revalidar (não a rebaixar tudo
    # pra sem-cache-nenhum: ainda usa ETag/304 quando o arquivo não mudou).
    app.config["SEND_FILE_MAX_AGE_DEFAULT"] = 0
    if test_config:
        app.config.update(test_config)

    @app.teardown_appcontext
    def _teardown(exception=None):
        close_db(exception)

    @app.errorhandler(ApiError)
    def _handle_api_error(err: ApiError):
        corpo = {"erro": err.codigo, "mensagem": err.mensagem}
        corpo.update(getattr(err, "extra", None) or {})
        return jsonify(corpo), err.status

    @app.errorhandler(404)
    def _handle_404(err):
        return jsonify({"erro": "nao_encontrado", "mensagem": "Rota não encontrada."}), 404

    @app.errorhandler(405)
    def _handle_405(err):
        return jsonify({"erro": "metodo_nao_permitido", "mensagem": "Método HTTP não permitido para esta rota."}), 405

    @app.errorhandler(413)
    def _handle_413(err):
        return jsonify({"erro": "arquivo_grande_demais", "mensagem": "Arquivo maior que o limite permitido."}), 413

    @app.errorhandler(Exception)
    def _handle_unexpected(err):
        app.logger.exception("Erro não tratado")
        return jsonify({"erro": "erro_interno", "mensagem": "Erro interno do servidor."}), 500

    from .routes import auth, chat_interno, downloads, followup, sistema, usuarios, whatsapp
    app.register_blueprint(auth.bp)
    app.register_blueprint(whatsapp.bp)
    app.register_blueprint(usuarios.bp)
    app.register_blueprint(sistema.bp)
    app.register_blueprint(chat_interno.bp)
    app.register_blueprint(followup.bp)
    app.register_blueprint(downloads.bp)

    @app.get("/api/v1/saude")
    def saude():
        return jsonify({"status": "ok", "servico": "WhatsApp Inbox"})

    @app.get("/api/v1/versao")
    def versao():
        return jsonify({"versao": VERSAO_SERVIDOR})

    @app.get("/api/v1/marca")
    def marca():
        """Qual logo mostrar na tela de login. Sem autenticação porque a
        tela de login vem ANTES de existir sessão — e logo de empresa não
        é informação sigilosa. Usa a primeira empresa configurada: hoje
        cada instalação atende uma empresa; quando houver mais de uma no
        mesmo servidor, isso precisa passar a olhar o domínio de acesso."""
        from .context import get_db
        try:
            row = get_db().execute(
                "SELECT logo_url FROM configuracoes_whatsapp WHERE logo_url IS NOT NULL ORDER BY empresa_id LIMIT 1"
            ).fetchone()
            return jsonify({"logo_url": row["logo_url"] if row else None})
        except Exception:
            return jsonify({"logo_url": None})

    @app.get("/")
    def frontend_index():
        return send_from_directory(FRONTEND_DIR, "index.html")

    @app.get("/instalador/WhattsInbox-instalador.zip")
    @app.get("/static/instalador/WhattsInbox-instalador.zip")
    def instalador_enderecos_antigos():
        """Dois endereços que o ZIP já teve. Agora ele mora junto da
        página de downloads, atrás do login do sistema."""
        return redirect("/downloads/WhattsInbox-instalador.zip", code=302)

    @app.get("/.well-known/assetlinks.json")
    def assetlinks():
        """Diz ao Android que o app instalado e este site sao da mesma
        dona — o Android confere a assinatura do app contra a impressão
        digital daqui.

        Sem isso o app até abre, mas com a barra de endereço do
        navegador em cima, e deixa de parecer um aplicativo. Tem que
        ficar exatamente neste endereço, em HTTPS e sem redirecionamento:
        é onde o Android procura."""
        return send_from_directory(
            os.path.join(FRONTEND_DIR, "well-known"), "assetlinks.json",
            mimetype="application/json", max_age=0,
        )

    @app.get("/manifest.webmanifest")
    def manifesto_pwa():
        """Ficha do app pro celular (nome, ícone, cor) — é o que faz o
        Android/iOS oferecer "instalar" e abrir sem barra de navegador."""
        return send_from_directory(FRONTEND_DIR, "manifest.webmanifest", mimetype="application/manifest+json")

    @app.get("/sw.js")
    def service_worker():
        """Precisa ser servido da RAIZ: um service worker só controla o
        que está na pasta dele ou abaixo. Em /static/sw.js ele não
        controlaria "/", e o app não seria instalável."""
        resposta = send_from_directory(FRONTEND_DIR, "sw.js", mimetype="application/javascript")
        resposta.headers["Service-Worker-Allowed"] = "/"
        resposta.headers["Cache-Control"] = "no-cache"
        return resposta

    if not app.debug:
        logging.basicConfig(level=logging.INFO)

    return app
