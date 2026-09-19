-- Pedido do Clayton (2026-09-19): "limpar todas as conversas" (apagar
-- as mensagens de dentro de uma conversa, no WhatsApp e no chat
-- interno) -- por conversa, não em massa, com permissão configurável
-- de quem pode usar (não é liberado pra todo mundo por padrão, dado o
-- tanto que é destrutivo -- admin sempre pode, o resto só se liberado
-- aqui, mesmo padrão do já existente acesso_conversas).
ALTER TABLE usuarios ADD COLUMN pode_limpar_conversa INTEGER NOT NULL DEFAULT 0 CHECK (pode_limpar_conversa IN (0,1));
