-- Pedido do Clayton (2026-09-21): aviso automático (e manual) quando
-- uma conversa entra na janela de "perto de estourar o SLA" -- espelha
-- ultimo_aviso_sla_em (que já existe pro alerta de ESTOURADO), agora
-- pro alerta ANTECIPADO.
ALTER TABLE whatsapp_conversas ADD COLUMN ultimo_aviso_sla_proximo_em TEXT;
