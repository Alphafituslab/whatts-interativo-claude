-- Reações (o emoji/figurinha que o cliente "cola" numa mensagem).
--
-- Reação NÃO é mensagem nova: no WhatsApp ela aparece grudada na
-- mensagem que foi reagida. O sistema não conhecia esse tipo, então
-- tratava como mensagem comum — e como reação não tem texto nem mídia,
-- entrava uma bolha em branco na conversa. Guardando aqui, na própria
-- mensagem reagida, ela aparece onde deve e para de poluir o histórico.
ALTER TABLE whatsapp_mensagens ADD COLUMN reacao TEXT;
ALTER TABLE whatsapp_mensagens ADD COLUMN reacao_em TEXT;
