-- Quem está no grupo do lado do CLIENTE (os participantes do WhatsApp),
-- diferente de whatsapp_conversa_usuarios, que é a nossa equipe.
--
-- Existe por dois motivos:
--
-- 1. Poder mostrar a lista de quem está no grupo, com nome — hoje só dá
--    pra ver o nome do grupo e adivinhar quem está dentro.
--
-- 2. Descobrir QUEM FALOU. É a causa do bug antigo das mensagens de
--    grupo chegarem sem autor: o WhatsApp identifica o participante por
--    um "lid" (ex.: 224206201614517@lid), que não é telefone nenhum e
--    não bate com contato nenhum. A tradução lid -> telefone só existe
--    na lista de participantes do grupo, então ela fica guardada aqui.
CREATE TABLE IF NOT EXISTS whatsapp_grupo_membros (
    contato_id    INTEGER NOT NULL REFERENCES whatsapp_contatos(id),
    lid           TEXT NOT NULL,
    telefone      TEXT,
    nome          TEXT,
    admin         TEXT,
    foto_url      TEXT,
    atualizado_em TEXT NOT NULL,
    PRIMARY KEY (contato_id, lid)
);

CREATE INDEX IF NOT EXISTS idx_grupo_membros_lid ON whatsapp_grupo_membros(lid);

-- Quando a lista foi buscada pela última vez, pra não perguntar ao
-- WhatsApp a cada mensagem que chega.
ALTER TABLE whatsapp_contatos ADD COLUMN membros_atualizados_em TEXT;
