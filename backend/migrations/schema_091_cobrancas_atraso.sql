-- Clayton (2026-09-14): mostrar a data da ultima cobranca de atraso
-- feita numa conversa, pra nao mandar cobranca repetida sem saber.
CREATE TABLE whatsapp_cobrancas_atraso (
    id                     INTEGER PRIMARY KEY AUTOINCREMENT,
    empresa_id             INTEGER NOT NULL REFERENCES empresas(id),
    usuario_atendente_id   INTEGER NOT NULL REFERENCES usuarios(id),
    conversa_id            INTEGER NOT NULL REFERENCES whatsapp_conversas(id),
    texto                  TEXT NOT NULL,
    criado_em              TEXT NOT NULL,
    criado_por_id          INTEGER REFERENCES usuarios(id)
);
CREATE INDEX idx_cobrancas_atraso_atendente ON whatsapp_cobrancas_atraso(empresa_id, usuario_atendente_id);
