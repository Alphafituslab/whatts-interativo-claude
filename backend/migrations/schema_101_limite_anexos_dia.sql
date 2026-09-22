-- Pedido do Clayton (2026-09-22), ano de eleição -- "a menor deslize
-- podemos perder o número": teto DIÁRIO pra soma de anexos/fotos/PDFs
-- mandados por TODOS os usuários da empresa juntos (não é por pessoa,
-- é o total da empresa), configurável. Diferente do freio de repetição
-- (schema_100, mesmo arquivo) -- esse conta QUALQUER anexo, repetido
-- ou não.
ALTER TABLE configuracoes_whatsapp ADD COLUMN limite_anexos_dia INTEGER NOT NULL DEFAULT 6;
