-- Etiqueta passa a ser de CADA USUÁRIO, não da empresa.
--
-- Pedido: "ao identificar um cliente com uma etiqueta os outros usuários
-- não possam ver, e que todos tenham suas etiquetas e nomes próprios".
-- Cada um organiza a própria carteira do jeito dele — a etiqueta que eu
-- ponho num cliente é anotação minha, não informação da empresa.
--
-- Como a etiqueta tem dono, a atribuição herda o dono junto: para saber
-- se uma etiquetagem é minha basta olhar de quem é a etiqueta. Por isso
-- as tabelas de ligação (whatsapp_conversa_tags e
-- chat_interno_conversa_tags) não mudam.
--
-- É preciso reconstruir a tabela porque o UNIQUE antigo era
-- (empresa_id, nome): com ele, se o Clayton criasse "Urgente", mais
-- ninguém na empresa conseguiria ter uma "Urgente" própria. O novo é
-- (empresa_id, usuario_id, nome).
--
-- As etiquetas que já existiam passam a ser de quem administra a
-- empresa (foi quem as criou, quando a tela era só de admin).

PRAGMA foreign_keys = OFF;

CREATE TABLE whatsapp_tags_novo (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    empresa_id  INTEGER NOT NULL REFERENCES empresas(id),
    usuario_id  INTEGER REFERENCES usuarios(id),
    nome        TEXT NOT NULL,
    cor         TEXT NOT NULL DEFAULT '#6b7280',
    UNIQUE (empresa_id, usuario_id, nome)
);

INSERT INTO whatsapp_tags_novo (id, empresa_id, usuario_id, nome, cor)
SELECT t.id,
       t.empresa_id,
       (SELECT u.id FROM usuarios u
         WHERE u.empresa_id = t.empresa_id AND u.admin = 1 AND u.ativo = 1
         ORDER BY u.id LIMIT 1),
       t.nome,
       t.cor
FROM whatsapp_tags t;

DROP TABLE whatsapp_tags;
ALTER TABLE whatsapp_tags_novo RENAME TO whatsapp_tags;

-- Etiquetagem órfã (de etiqueta que sumiu) não deve sobrar.
DELETE FROM whatsapp_conversa_tags
 WHERE tag_id NOT IN (SELECT id FROM whatsapp_tags);
DELETE FROM chat_interno_conversa_tags
 WHERE tag_id NOT IN (SELECT id FROM whatsapp_tags);

-- Faxina de uma linha órfã deixada por testes antigos: um
-- encaminhamento apontando para uma conversa interna já apagada. Não
-- tem a ver com etiquetas, mas é uma violação de chave estrangeira real
-- no banco (PRAGMA foreign_key_check acusa) e sobrar assim atrapalha
-- qualquer manutenção futura.
DELETE FROM chat_interno_encaminhamentos
 WHERE conversa_id NOT IN (SELECT id FROM chat_interno_conversas);

PRAGMA foreign_keys = ON;
