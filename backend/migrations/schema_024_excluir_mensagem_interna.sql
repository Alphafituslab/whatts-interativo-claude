-- Permite apagar mensagem mandada por engano no chat interno (texto,
-- foto, áudio, o que for) — como já dava nas conversas de cliente.
-- Marca a data em vez de apagar a linha: mantém o histórico coerente
-- (mesma escolha de whatsapp_mensagens.excluida_em).
ALTER TABLE chat_interno_mensagens ADD COLUMN excluida_em TEXT;
