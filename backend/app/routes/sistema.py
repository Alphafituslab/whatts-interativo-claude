"""Backup e restauração do sistema.

TODAS as rotas aqui são restritas ao dono da plataforma
(requires_super_admin), não ao admin de cada empresa: o backup é do
banco inteiro, com os dados de todas as empresas juntos. Um admin de
empresa com acesso a isto conseguiria baixar os dados das outras
empresas, ou restaurar um backup antigo por cima do trabalho delas."""
import os

from flask import Blueprint, jsonify, request, send_file

from .. import backup
from ..context import ApiError, requires_super_admin

bp = Blueprint("sistema", __name__, url_prefix="/api/v1/sistema")


@bp.get("/backups")
@requires_super_admin
def listar_backups():
    pasta = backup._pasta_backups()
    entradas = sorted(
        (e for e in os.listdir(pasta) if os.path.isdir(os.path.join(pasta, e)) and backup.caminho_backup(e)),
        reverse=True,
    )
    return jsonify(entradas)


@bp.post("/backups")
@requires_super_admin
def fazer_backup_agora():
    caminho = backup.executar_backup()
    return jsonify({"ok": True, "pasta": os.path.basename(caminho)}), 201


@bp.get("/backups/<nome>/download")
@requires_super_admin
def baixar_backup(nome):
    try:
        buffer = backup.zipar_backup(nome)
    except FileNotFoundError:
        raise ApiError("Backup não encontrado.", status=404, codigo="nao_encontrado")
    return send_file(
        buffer, as_attachment=True, download_name=f"whatts-backup-{nome}.zip", mimetype="application/zip"
    )


@bp.post("/backups/<nome>/restaurar")
@requires_super_admin
def restaurar_backup(nome):
    """Sobrescreve o banco e os arquivos ATUAIS pelo conteúdo desse
    backup — ação destrutiva (ver backup.restaurar_backup: faz um backup
    de segurança do estado atual antes, mas ainda assim substitui tudo
    que foi criado depois da data desse backup)."""
    try:
        backup.restaurar_backup(nome)
    except FileNotFoundError:
        raise ApiError("Backup não encontrado.", status=404, codigo="nao_encontrado")
    return jsonify({"ok": True})


@bp.post("/backups/importar")
@requires_super_admin
def importar_backup():
    """Restaura a partir de um .zip enviado (baixado daqui antes, ou
    trazido de outra instalação) — mesmo aviso de ação destrutiva da
    rota de restaurar acima."""
    arquivo = request.files.get("arquivo")
    if not arquivo or not arquivo.filename:
        raise ApiError("Nenhum arquivo enviado.", status=400)
    if not arquivo.filename.lower().endswith(".zip"):
        raise ApiError("O arquivo precisa ser um .zip de backup.", status=400)
    try:
        backup.importar_e_restaurar(arquivo.stream)
    except (ValueError, KeyError):
        raise ApiError("Esse arquivo não parece ser um backup válido do Seja Alpha.", status=400)
    return jsonify({"ok": True})
