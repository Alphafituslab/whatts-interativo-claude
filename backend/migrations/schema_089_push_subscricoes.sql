-- Clayton (2026-09-14): notificacao push no celular mesmo com o app
-- fechado (o app ja era instalavel/PWA de antes -- isso so adiciona o
-- aviso funcionar fora da aba aberta). Cada usuario pode ter mais de
-- uma inscricao (celular + computador, por exemplo).
CREATE TABLE whatsapp_push_subscricoes (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    usuario_id    INTEGER NOT NULL REFERENCES usuarios(id),
    endpoint      TEXT NOT NULL UNIQUE,
    p256dh        TEXT NOT NULL,
    auth          TEXT NOT NULL,
    criado_em     TEXT NOT NULL
);
CREATE INDEX idx_push_subscricoes_usuario ON whatsapp_push_subscricoes(usuario_id);
