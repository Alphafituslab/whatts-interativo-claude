"""Rotas administrativas de sistema: backup manual e listagem de backups."""
import os

from flask import Blueprint, jsonify

from .. import backup
from ..context import requires_admin

bp = Blueprint("sistema", __name__, url_prefix="/api/v1/sistema")


@bp.get("/backups")
@requires_admin
def listar_backups():
    pasta = backup._pasta_backups()
    entradas = sorted(
        (e for e in os.listdir(pasta) if os.path.isdir(os.path.join(pasta, e))),
        reverse=True,
    )
    return jsonify(entradas)


@bp.post("/backups")
@requires_admin
def fazer_backup_agora():
    caminho = backup.executar_backup()
    return jsonify({"ok": True, "pasta": os.path.basename(caminho)}), 201
