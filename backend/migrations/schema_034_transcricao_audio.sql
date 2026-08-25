-- Transcrição dos áudios.
--
-- Guardada no banco (e não gerada toda vez) porque transcrever custa
-- alguns segundos de processador: feito uma vez, todo mundo que abrir
-- a conversa depois lê na hora, sem refazer o trabalho.
--
-- transcricao_em serve pra distinguir "ninguém pediu ainda" (NULL) de
-- "pedi e não deu pra entender nada" (data preenchida, texto vazio) —
-- sem isso a tela ficaria oferecendo transcrever de novo pra sempre um
-- áudio que é só barulho.
ALTER TABLE whatsapp_mensagens ADD COLUMN transcricao TEXT;
ALTER TABLE whatsapp_mensagens ADD COLUMN transcricao_em TEXT;

ALTER TABLE chat_interno_mensagens ADD COLUMN transcricao TEXT;
ALTER TABLE chat_interno_mensagens ADD COLUMN transcricao_em TEXT;
