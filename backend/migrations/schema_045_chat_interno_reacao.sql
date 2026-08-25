-- Reagir a uma mensagem do chat interno, como já dá nas conversas de
-- cliente. Aqui a reação é só nossa: não passa pelo WhatsApp, então
-- basta guardar o emoji e quando foi.
--
-- Guarda também QUEM reagiu: no chat interno são duas pessoas na mesma
-- conversa, e "quem colocou o 👍" é justamente o que se quer saber.
ALTER TABLE chat_interno_mensagens ADD COLUMN reacao TEXT;
ALTER TABLE chat_interno_mensagens ADD COLUMN reacao_em TEXT;
ALTER TABLE chat_interno_mensagens ADD COLUMN reacao_por INTEGER REFERENCES usuarios(id);

-- Encaminhada de outra conversa (interna ou de cliente), pra bolha poder
-- marcar "↪️ Encaminhada" em vez de parecer texto escrito na hora.
ALTER TABLE chat_interno_mensagens ADD COLUMN encaminhada INTEGER NOT NULL DEFAULT 0;
