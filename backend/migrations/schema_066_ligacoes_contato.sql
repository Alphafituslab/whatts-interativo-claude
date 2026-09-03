-- ============================================================
-- Pedido do Clayton (2026-09-03): telefone, e-mail e data de envio do
-- e-mail na planilha de Ligações.
-- ============================================================
ALTER TABLE crm_ligacoes ADD COLUMN telefone TEXT;
ALTER TABLE crm_ligacoes ADD COLUMN email TEXT;
ALTER TABLE crm_ligacoes ADD COLUMN data_envio_email TEXT;
