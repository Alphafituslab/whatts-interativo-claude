-- ============================================================
-- Prorrogar conversa parada antes de encerrar automaticamente. Pedido
-- do Clayton (2026-09-03): antes de fechar sozinha, o operador pode
-- escolher prorrogar pelo mesmo prazo (aviso_conversa_parada_horas),
-- até um número máximo de vezes configurável.
-- ============================================================
ALTER TABLE whatsapp_conversas ADD COLUMN prorrogada_ate TEXT;
ALTER TABLE whatsapp_conversas ADD COLUMN vezes_prorrogada INTEGER NOT NULL DEFAULT 0;

ALTER TABLE configuracoes_whatsapp ADD COLUMN aviso_conversa_parada_max_prorrogacoes INTEGER NOT NULL DEFAULT 3;
