-- Deixa configurável o limite de "mesma mensagem repetida" que hoje
-- era fixo em 5 no código (LIMITE_REPETICOES_MENSAGEM) -- pedido do
-- Clayton (2026-09-11): "deixar que eu possa configurar tbm essa
-- quantidade", junto dos outros freios de ritmo de envio.
ALTER TABLE configuracoes_whatsapp ADD COLUMN limite_repeticao_mensagem INTEGER NOT NULL DEFAULT 5;
