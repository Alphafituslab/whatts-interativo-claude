-- Permite anexar imagem/vídeo/documento/áudio a uma mensagem agendada
-- (antes só dava pra agendar texto puro).
ALTER TABLE whatsapp_mensagens_agendadas ADD COLUMN tipo TEXT NOT NULL DEFAULT 'texto';
ALTER TABLE whatsapp_mensagens_agendadas ADD COLUMN midia_url TEXT;
ALTER TABLE whatsapp_mensagens_agendadas ADD COLUMN nome_arquivo TEXT;
