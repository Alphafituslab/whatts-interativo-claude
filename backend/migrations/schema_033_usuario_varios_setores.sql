-- Um usuário pode atender VÁRIOS setores do menu.
--
-- Antes era um só (usuarios.setor), então quem fazia Televendas e
-- Financeiro precisava de dois cadastros. Agora a mesma pessoa marca os
-- dois e recebe as conversas de ambos.
--
-- A coluna usuarios.setor continua existindo e passa a guardar o setor
-- PRINCIPAL (o primeiro da lista). Ela ainda é útil como rótulo de uma
-- pessoa só — é o que aparece, por exemplo, como destino de uma
-- conversa do chat interno. Quem manda em visibilidade e no menu
-- automático é a tabela abaixo.
CREATE TABLE usuario_setores (
    usuario_id  INTEGER NOT NULL REFERENCES usuarios(id),
    setor       TEXT NOT NULL,
    PRIMARY KEY (usuario_id, setor)
);

-- Ninguém perde nada: cada pessoa começa com exatamente o setor que já
-- tinha. Admin costuma ficar sem setor, e continua sem.
INSERT INTO usuario_setores (usuario_id, setor)
SELECT id, setor FROM usuarios
 WHERE setor IS NOT NULL AND TRIM(setor) != '';

CREATE INDEX idx_usuario_setores_setor ON usuario_setores(setor);
