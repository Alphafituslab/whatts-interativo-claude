-- ============================================================
-- Planilha de Ligações -- pedido do Clayton (2026-09-03): controlar as
-- ligações de prospecção dele (dia, empresa, com quem falou, pra quem
-- terceirizam, quem é o responsável pela área de suplementos/novos
-- produtos/contratação de fabricantes), editável direto no sistema,
-- com histórico completo e exportação em Excel/PDF.
-- ============================================================
CREATE TABLE crm_ligacoes (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    empresa_id          INTEGER NOT NULL,
    data_ligacao        TEXT,
    empresa_contatada   TEXT,
    contato_nome        TEXT,
    terceiriza_para     TEXT,
    responsavel_area    TEXT,
    observacoes         TEXT,
    ordem               INTEGER NOT NULL DEFAULT 0,
    criado_por          INTEGER REFERENCES usuarios(id),
    criado_em           TEXT NOT NULL,
    atualizado_em       TEXT,
    atualizado_por      INTEGER REFERENCES usuarios(id)
);
CREATE INDEX idx_crm_ligacoes_empresa ON crm_ligacoes(empresa_id, ordem);
