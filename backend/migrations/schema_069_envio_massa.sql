-- ============================================================
-- Envio em massa pro WhatsApp -- pedido do Clayton (2026-09-04):
-- "poder enviar mensagens em massa para mais de um contato ou varios
-- no whatts, ao construir deixar configuravel para habilitar e
-- desabilitar essa funcao". Desligado por padrao -- ativa em
-- Configuracao quando quiser usar. Risco real de banimento do numero
-- (ja documentado no aviso da tela de Configuracao) -- por isso
-- passa pelo MESMO freio de ritmo (verificar_ritmo_envio) que qualquer
-- outro envio, e roda espacado (nao tudo de uma vez).
-- ============================================================
ALTER TABLE configuracoes_whatsapp ADD COLUMN envio_massa_ativo INTEGER NOT NULL DEFAULT 0 CHECK (envio_massa_ativo IN (0,1));
ALTER TABLE configuracoes_whatsapp ADD COLUMN envio_massa_intervalo_segundos INTEGER NOT NULL DEFAULT 8;

CREATE TABLE whatsapp_envios_massa (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    empresa_id      INTEGER NOT NULL,
    texto           TEXT,
    midia_url       TEXT,
    nome_arquivo    TEXT,
    total           INTEGER NOT NULL DEFAULT 0,
    enviados        INTEGER NOT NULL DEFAULT 0,
    falhados        INTEGER NOT NULL DEFAULT 0,
    status          TEXT NOT NULL DEFAULT 'processando' CHECK (status IN ('processando', 'concluido', 'cancelado')),
    criado_por      INTEGER REFERENCES usuarios(id),
    criado_em       TEXT NOT NULL,
    concluido_em    TEXT
);

CREATE TABLE whatsapp_envios_massa_itens (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    envio_id        INTEGER NOT NULL REFERENCES whatsapp_envios_massa(id),
    conversa_id     INTEGER,
    contato_nome    TEXT,
    telefone        TEXT,
    status          TEXT NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente', 'enviado', 'falhou')),
    erro            TEXT,
    mensagem_id     INTEGER,
    atualizado_em   TEXT
);
CREATE INDEX idx_envios_massa_itens_envio ON whatsapp_envios_massa_itens(envio_id);

ALTER TABLE whatsapp_mensagens ADD COLUMN envio_massa_id INTEGER;
