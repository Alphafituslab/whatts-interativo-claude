-- Citar uma mensagem (responder a ela) e editar o que foi escrito.
--
-- responde_a: id da mensagem citada, na MESMA tabela. Guardado como id e
-- não como cópia do texto, pra citação continuar refletindo a mensagem
-- real (inclusive quando ela é apagada — aí a citação mostra que foi).
--
-- editada_em: fica NULL enquanto ninguém editou. Quando tem valor, a
-- bolha mostra "editada" — igual ao WhatsApp, pra ninguém alterar o que
-- disse sem deixar rastro na conversa.
ALTER TABLE whatsapp_mensagens ADD COLUMN responde_a INTEGER REFERENCES whatsapp_mensagens(id);
ALTER TABLE whatsapp_mensagens ADD COLUMN editada_em TEXT;

ALTER TABLE chat_interno_mensagens ADD COLUMN responde_a INTEGER REFERENCES chat_interno_mensagens(id);
ALTER TABLE chat_interno_mensagens ADD COLUMN editada_em TEXT;
