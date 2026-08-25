-- Quem falou, dentro de um grupo.
--
-- Numa conversa de uma pessoa só, o remetente é o próprio contato da
-- conversa — não há o que guardar. Em grupo não: a conversa é o grupo, e
-- cada mensagem vem de um participante diferente. Sem registrar isso, o
-- histórico do grupo vira um monte de falas sem dono, e não dá pra saber
-- quem pediu o quê.
ALTER TABLE whatsapp_mensagens ADD COLUMN autor_nome TEXT;
ALTER TABLE whatsapp_mensagens ADD COLUMN autor_telefone TEXT;
