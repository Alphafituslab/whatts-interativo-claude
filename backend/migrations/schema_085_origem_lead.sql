-- Origem do lead -- pedido do Clayton (2026-09-11): saber se cada
-- atendimento veio de trafego pago (link da landing page, com mensagem
-- pre-cadastrada), foi captacao propria (atendente escreveu primeiro,
-- "+ Nova conversa") ou o cliente chegou por conta propria (escreveu
-- primeiro mas nao veio da landing page). Preenchido automaticamente
-- na hora que a conversa NASCE -- nao muda depois disso.
ALTER TABLE whatsapp_conversas ADD COLUMN origem_lead TEXT;
