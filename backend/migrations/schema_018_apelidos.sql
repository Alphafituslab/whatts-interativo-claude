-- Apelido privado: cada usuário pode dar seu próprio apelido pra um
-- colega no chat interno — só quem definiu vê esse nome, o cadastro
-- real da pessoa (usuarios.nome) não muda pra mais ninguém.
CREATE TABLE usuarios_apelidos (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    usuario_id     INTEGER NOT NULL,
    alvo_usuario_id INTEGER NOT NULL,
    apelido        TEXT NOT NULL,
    atualizado_em  TEXT NOT NULL,
    UNIQUE(usuario_id, alvo_usuario_id)
);
