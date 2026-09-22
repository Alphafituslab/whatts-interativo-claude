-- Pedido do Clayton (2026-09-22): "pedir a senha ao baixar e que a
-- senha seja enviada por mim, uma senha provisoria que deve expirar"
-- -- código temporário de uso único pra acessar a página de downloads
-- sem precisar de login de verdade no sistema (ex.: técnico externo
-- configurando uma máquina nova). Clayton gera, envia manualmente por
-- fora (WhatsApp etc.), e o código vale só uma vez, dentro do prazo.
CREATE TABLE downloads_codigos_temporarios (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    empresa_id INTEGER NOT NULL REFERENCES empresas(id),
    codigo TEXT NOT NULL,
    criado_por_id INTEGER REFERENCES usuarios(id),
    criado_em TEXT NOT NULL,
    expira_em TEXT NOT NULL,
    usado_em TEXT
);
CREATE INDEX idx_downloads_codigos_codigo ON downloads_codigos_temporarios(codigo);
