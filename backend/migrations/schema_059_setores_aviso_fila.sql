-- ============================================================
-- Aviso de fila do "Sem escolha": pra quais setores manda -- pedido do
-- Clayton (2026-09-01): "ele envia uma mensagem para os televendas
-- avisando cliente na fila" -- lista vazia/NULL mantém o comportamento
-- de avisar todo mundo online (era o padrão até aqui).
-- ============================================================
ALTER TABLE configuracoes_whatsapp ADD COLUMN aviso_fila_sem_escolha_setores TEXT;
