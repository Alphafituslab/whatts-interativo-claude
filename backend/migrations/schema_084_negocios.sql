-- CRM de vendas (funil) -- pedido do Clayton (2026-09-11): "bora
-- construir algo top... tudo monitoravel por mim". Negocio = uma
-- oportunidade de venda em andamento (ou ja fechada), com estagio e
-- valor -- coisa que o marcador binario "negociacao fechada" que ja
-- existia (whatsapp_negociacoes_fechadas) nunca teve.
CREATE TABLE whatsapp_negocios (
    id                      INTEGER PRIMARY KEY AUTOINCREMENT,
    empresa_id              INTEGER NOT NULL REFERENCES empresas(id),
    contato_id              INTEGER NOT NULL REFERENCES whatsapp_contatos(id),
    conversa_id             INTEGER REFERENCES whatsapp_conversas(id),
    titulo                  TEXT,
    valor                   REAL,
    estagio                 TEXT NOT NULL DEFAULT 'lead',
    responsavel_usuario_id  INTEGER REFERENCES usuarios(id),
    criado_por_id           INTEGER REFERENCES usuarios(id),
    criado_em               TEXT NOT NULL,
    atualizado_em           TEXT NOT NULL,
    fechado_em              TEXT,
    resultado               TEXT CHECK (resultado IN ('ganho','perdido') OR resultado IS NULL),
    motivo_perda            TEXT
);
CREATE INDEX idx_negocios_empresa_estagio ON whatsapp_negocios(empresa_id, estagio);
CREATE INDEX idx_negocios_contato ON whatsapp_negocios(contato_id);
CREATE INDEX idx_negocios_conversa ON whatsapp_negocios(conversa_id);
CREATE INDEX idx_negocios_responsavel ON whatsapp_negocios(responsavel_usuario_id);
