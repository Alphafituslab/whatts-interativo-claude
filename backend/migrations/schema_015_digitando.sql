-- Indicador de "digitando..." — expira sozinho (checado por tempo, não
-- por um evento de "parou de digitar", que nem sempre chega).
ALTER TABLE whatsapp_conversas ADD COLUMN digitando_ate TEXT;
ALTER TABLE chat_interno_conversas ADD COLUMN digitando_criador_ate TEXT;
ALTER TABLE chat_interno_conversas ADD COLUMN digitando_participante_ate TEXT;
