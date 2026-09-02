-- ============================================================
-- Usuário do sistema: quem manda os avisos automáticos (lembrete de
-- follow-up, fila do "Sem escolha" parada) -- pedido do Clayton
-- (2026-09-01), pensando também em, mais pra frente, virar a conta que
-- representa a IA quando for liberada.
-- ============================================================
ALTER TABLE configuracoes_whatsapp ADD COLUMN usuario_sistema_id INTEGER REFERENCES usuarios(id);

-- Aviso de fila parada no "Sem escolha" -- desligado até o Clayton
-- ativar em Configuração.
ALTER TABLE configuracoes_whatsapp ADD COLUMN aviso_fila_sem_escolha_ativo INTEGER NOT NULL DEFAULT 0;
ALTER TABLE configuracoes_whatsapp ADD COLUMN ultimo_aviso_fila_sem_escolha TEXT;
