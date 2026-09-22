-- Pedido do Clayton (2026-09-22): marca d'água discreta (nome + email +
-- data/hora de quem está vendo) por cima das conversas, pra desencorajar
-- print e deixar rastro se vazar. Configurável POR USUÁRIO (ele mesmo
-- controla no próprio cadastro, e também escolhe pra quem mais ativar)
-- -- não é liga/desliga geral da empresa. Desligado por padrão pra
-- todo mundo, inclusive quem já existe.
ALTER TABLE usuarios ADD COLUMN marca_dagua_ativa INTEGER NOT NULL DEFAULT 0;
