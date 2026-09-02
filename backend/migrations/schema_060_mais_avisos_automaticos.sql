-- ============================================================
-- Mais avisos automáticos do usuário do sistema (pedido do Clayton,
-- 2026-09-01): conversa parada sem resposta (SLA), resumo diário pro
-- admin, boas-vindas a novo colaborador. Todos desligados por padrão
-- até ativar em Configuração > Avisos automáticos.
-- ============================================================
ALTER TABLE configuracoes_whatsapp ADD COLUMN aviso_sla_ativo INTEGER NOT NULL DEFAULT 0;
ALTER TABLE whatsapp_conversas ADD COLUMN ultimo_aviso_sla_em TEXT;

ALTER TABLE configuracoes_whatsapp ADD COLUMN aviso_resumo_diario_ativo INTEGER NOT NULL DEFAULT 0;
ALTER TABLE configuracoes_whatsapp ADD COLUMN ultimo_resumo_diario_em TEXT;

ALTER TABLE configuracoes_whatsapp ADD COLUMN aviso_boasvindas_ativo INTEGER NOT NULL DEFAULT 0;
