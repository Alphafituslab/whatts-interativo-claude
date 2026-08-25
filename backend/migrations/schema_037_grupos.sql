-- Grupos de WhatsApp.
--
-- Um grupo entra no sistema como um "contato", pra reaproveitar tudo o
-- que já existe em volta de conversa: lista, mensagens, etiquetas,
-- anexos, busca. O que muda é o endereço: pessoa é
-- <numero>@s.whatsapp.net e grupo é <id>@g.us — daí a coluna abaixo,
-- que diz qual dos dois usar na hora de enviar.
--
-- O id do grupo também não é telefone: não leva DDD nem o 9 do celular,
-- então normalizar como número o estragaria. Por isso quem é grupo pula
-- essa normalização.
ALTER TABLE whatsapp_contatos ADD COLUMN eh_grupo INTEGER NOT NULL DEFAULT 0
    CHECK (eh_grupo IN (0, 1));
