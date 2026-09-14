-- Clayton (2026-09-14): alerta de proposta parada no funil de vendas --
-- avisar quando um negocio fica dias sem avancar de estagio. Vem com
-- toggle (fica desligado por padrao) pra ele poder desabilitar se nao
-- quiser usar.
ALTER TABLE configuracoes_whatsapp ADD COLUMN alerta_negocio_parado_ativo INTEGER NOT NULL DEFAULT 0;
ALTER TABLE configuracoes_whatsapp ADD COLUMN alerta_negocio_parado_dias INTEGER NOT NULL DEFAULT 3;
