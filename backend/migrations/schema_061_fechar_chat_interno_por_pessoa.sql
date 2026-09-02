-- ============================================================
-- Encerrar uma conversa do chat interno deixa de ser compartilhado.
-- Achado pelo Clayton (2026-09-02): quando UM lado encerrava, a
-- conversa sumia da tela do OUTRO também. Cada lado passa a ter seu
-- próprio "encerrado" -- fechar só tira da SUA lista; o outro continua
-- vendo normal até fechar também (ou até mandarem mensagem de novo,
-- que reabre pros dois, como já era).
-- ============================================================
ALTER TABLE chat_interno_conversas ADD COLUMN fechada_para_criador_em TEXT;
ALTER TABLE chat_interno_conversas ADD COLUMN fechada_para_participante_em TEXT;

-- Migra o que já estava encerrado: os dois lados ficam com o mesmo
-- estado que já tinham hoje (fechado pros dois) -- ninguém "reabre"
-- sozinho por causa desta migration.
UPDATE chat_interno_conversas
SET fechada_para_criador_em = fechada_em, fechada_para_participante_em = fechada_em
WHERE status = 'fechada';
