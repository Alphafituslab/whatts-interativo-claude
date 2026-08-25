-- Índices para a checagem de novidades (GET /whatsapp/pulso).
--
-- Essa consulta roda várias vezes por segundo, por pessoa com a tela
-- aberta — é o que faz a mensagem aparecer quase na hora. Sem índice
-- ela varre a tabela de mensagens inteira a cada chamada, e o custo
-- cresce junto com o histórico: rápido hoje, lento daqui a um ano.
CREATE INDEX IF NOT EXISTS idx_msg_direcao_status
    ON whatsapp_mensagens(direcao, status);

CREATE INDEX IF NOT EXISTS idx_msg_conversa
    ON whatsapp_mensagens(conversa_id);

CREATE INDEX IF NOT EXISTS idx_msg_interna_conversa
    ON chat_interno_mensagens(conversa_id);
