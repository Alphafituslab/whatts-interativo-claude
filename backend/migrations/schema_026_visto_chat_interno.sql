-- "Visualizado" no chat interno.
--
-- Em vez de marcar mensagem por mensagem, guarda em cada conversa a
-- data em que cada lado leu pela última vez: toda mensagem anterior a
-- essa data foi vista. É uma linha por conversa em vez de uma marcação
-- por mensagem, e o resultado pro usuário é o mesmo.
ALTER TABLE chat_interno_conversas ADD COLUMN visto_criador_em      TEXT;
ALTER TABLE chat_interno_conversas ADD COLUMN visto_participante_em TEXT;
