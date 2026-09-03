-- ============================================================
-- Grau de aceitação do lead (Quente/Morno/Frio) + marcação de
-- negociação fechada -- pedido do Clayton (2026-09-03) na planilha
-- "Leads do Consulta Anvisa": medir o grau de aceitação do cliente ao
-- conversar/mandar e-mail, pra depois filtrar e ordenar por isso e por
-- negociações fechadas.
-- ============================================================
ALTER TABLE crm_ligacoes ADD COLUMN aceitacao TEXT CHECK (aceitacao IN ('quente', 'morno', 'frio') OR aceitacao IS NULL);
ALTER TABLE crm_ligacoes ADD COLUMN negociacao_fechada INTEGER NOT NULL DEFAULT 0 CHECK (negociacao_fechada IN (0,1));
