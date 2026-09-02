-- ============================================================
-- Aviso de conversa parada esperando o CLIENTE (o contrário do SLA, que
-- avisa quando é o cliente esperando o agente). Achado pelo Clayton
-- (2026-09-02) ao ver um "pior atendimento" de 167h no dashboard: era
-- conversa que ficou "aberta" dias sem ninguém fechar porque o cliente
-- simplesmente parou de responder. Agora: depois de X horas sem
-- resposta do cliente, avisa o responsável; se ele não interagir em Y
-- minutos, a conversa é encerrada sozinha.
-- ============================================================
ALTER TABLE configuracoes_whatsapp ADD COLUMN aviso_conversa_parada_ativo INTEGER NOT NULL DEFAULT 0 CHECK (aviso_conversa_parada_ativo IN (0,1));
ALTER TABLE configuracoes_whatsapp ADD COLUMN aviso_conversa_parada_horas INTEGER NOT NULL DEFAULT 24;
ALTER TABLE configuracoes_whatsapp ADD COLUMN aviso_conversa_parada_minutos_fechar INTEGER NOT NULL DEFAULT 10;

ALTER TABLE whatsapp_conversas ADD COLUMN aviso_fechamento_automatico_em TEXT;
