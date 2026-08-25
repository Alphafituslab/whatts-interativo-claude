-- Colaborador que só usa o chat interno.
--
-- Tem gente na empresa que precisa falar com a equipe mas não atende
-- cliente nenhum. Com esta coluna em 0, a pessoa entra no sistema,
-- conversa com os colegas, e as conversas de WhatsApp simplesmente não
-- existem pra ela — nem o menu, nem os avisos, nem a API.
--
-- Padrão 1 (liberado) pra ninguém perder acesso na atualização: hoje
-- todo mundo atende, e quem passar a ser só-chat-interno é escolhido a
-- dedo na tela de Usuários. Liberar de volta é trocar o mesmo campo.
--
-- Administrador ignora este campo: quem administra vê tudo.
ALTER TABLE usuarios ADD COLUMN acesso_conversas INTEGER NOT NULL DEFAULT 1
    CHECK (acesso_conversas IN (0, 1));
