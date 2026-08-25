-- Marca a mensagem que foi encaminhada de outra conversa, do mesmo jeito
-- que o WhatsApp faz. Sem isso, um documento repassado pra um cliente
-- parece um arquivo que a gente mesmo produziu — e ninguém consegue
-- voltar até a origem pra conferir de onde veio.
ALTER TABLE whatsapp_mensagens
    ADD COLUMN encaminhada_de INTEGER REFERENCES whatsapp_mensagens(id);
