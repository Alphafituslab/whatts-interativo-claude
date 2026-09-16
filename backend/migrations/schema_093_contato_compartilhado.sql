-- Clayton (2026-09-16): "quando um cliente encaminha um contato o
-- usuario nao consegue visualizar. deixar visualizar e salvar o
-- contato a partir do contato que foi recebido." O WhatsApp manda
-- contato compartilhado como contactMessage/contactsArrayMessage --
-- o sistema nao reconhecia nenhum dos dois, a mensagem chegava vazia.
ALTER TABLE whatsapp_mensagens ADD COLUMN contato_compartilhado_nome TEXT;
ALTER TABLE whatsapp_mensagens ADD COLUMN contato_compartilhado_telefone TEXT;
