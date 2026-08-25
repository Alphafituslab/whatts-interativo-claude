-- Quem da equipe participa de um grupo.
--
-- Um grupo não cabe no modelo de "uma conversa, um responsável": várias
-- pessoas daqui podem estar no mesmo grupo com o cliente. Mas também não
-- é de todo mundo — quem não está no grupo não tem por que ler o que se
-- fala lá dentro.
--
-- Vale só para conversa de grupo. Conversa um a um continua com o
-- atribuida_usuario_id de sempre.
CREATE TABLE IF NOT EXISTS whatsapp_conversa_usuarios (
    conversa_id  INTEGER NOT NULL REFERENCES whatsapp_conversas(id),
    usuario_id   INTEGER NOT NULL REFERENCES usuarios(id),
    adicionado_por INTEGER REFERENCES usuarios(id),
    criado_em    TEXT NOT NULL,
    PRIMARY KEY (conversa_id, usuario_id)
);

CREATE INDEX IF NOT EXISTS idx_wpp_conversa_usuarios_usuario
    ON whatsapp_conversa_usuarios(usuario_id);

-- Os grupos que já existem ganham como participante quem estava
-- respondendo por eles até agora: sem isso eles sumiriam da tela de
-- quem já os acompanhava.
INSERT OR IGNORE INTO whatsapp_conversa_usuarios (conversa_id, usuario_id, adicionado_por, criado_em)
SELECT c.id, a.usuario_id, a.usuario_id, datetime('now')
  FROM whatsapp_conversas c
  JOIN whatsapp_contatos ct ON ct.id = c.contato_id
  JOIN whatsapp_atribuicoes a ON a.conversa_id = c.id
 WHERE ct.eh_grupo = 1 AND a.usuario_id IS NOT NULL;
