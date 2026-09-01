-- ============================================================
-- Follow-up: aviso automático pro responsável quando o atraso passa de
-- um número de dias configurável (pedido do Clayton, 2026-09-01).
--
-- "Atraso" aqui é dias_parado - prazo_dias (quanto além do prazo já
-- combinado) -- não o total de dias sem contato. NULL/0 desliga o
-- aviso automático (continua só o botão manual "🔔 Avisar").
-- ============================================================
ALTER TABLE configuracoes_whatsapp ADD COLUMN followup_dias_aviso_automatico INTEGER;

-- Quando foi mandado o último aviso automático desta conversa -- evita
-- mandar de novo a cada rodada do agendador enquanto ela continuar
-- atrasada (mesmo raciocínio de ultimo_aviso_expediente).
ALTER TABLE whatsapp_conversas ADD COLUMN followup_aviso_automatico_em TEXT;
