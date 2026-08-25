-- Aceitar figurinha como tipo de mensagem.
--
-- BUG SÉRIO: a tabela tinha CHECK (tipo IN ('texto','imagem',
-- 'documento','audio','video','outro')) — sem 'figurinha'. O código já
-- classificava a figurinha recebida corretamente, mas a gravação era
-- recusada pelo banco: TODA figurinha que um cliente mandou foi
-- perdida, e por isso o banco de figurinhas da empresa nunca saía do
-- zero, mesmo com o botão de salvar funcionando.
--
-- Precisa reconstruir a tabela porque CHECK é constraint de tabela, e
-- SQLite não deixa alterá-la no lugar. Os dados são copiados por nome
-- de coluna, os índices são recriados no fim, e as chaves estrangeiras
-- ficam desligadas durante a troca (outras tabelas apontam pra esta).

PRAGMA foreign_keys = OFF;

CREATE TABLE whatsapp_mensagens_novo (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    conversa_id    INTEGER NOT NULL REFERENCES whatsapp_conversas(id),
    direcao        TEXT NOT NULL CHECK (direcao IN ('entrada','saida')),
    tipo           TEXT NOT NULL DEFAULT 'texto'
                   CHECK (tipo IN ('texto','imagem','documento','audio','video','figurinha','outro')),
    texto          TEXT,
    midia_url      TEXT,
    externo_id     TEXT UNIQUE,
    usuario_id     INTEGER REFERENCES usuarios(id),
    status         TEXT NOT NULL DEFAULT 'pendente'
                   CHECK (status IN ('pendente','enviada','entregue','lida','falhou','recebida')),
    erro           TEXT,
    criado_em      TEXT NOT NULL,
    excluida_em    TEXT,
    excluida_por   INTEGER,
    responde_a     INTEGER REFERENCES whatsapp_mensagens(id),
    editada_em     TEXT,
    transcricao    TEXT,
    transcricao_em TEXT,
    reacao         TEXT,
    reacao_em      TEXT
);

INSERT INTO whatsapp_mensagens_novo
    (id, conversa_id, direcao, tipo, texto, midia_url, externo_id, usuario_id, status, erro,
     criado_em, excluida_em, excluida_por, responde_a, editada_em, transcricao, transcricao_em,
     reacao, reacao_em)
SELECT id, conversa_id, direcao, tipo, texto, midia_url, externo_id, usuario_id, status, erro,
       criado_em, excluida_em, excluida_por, responde_a, editada_em, transcricao, transcricao_em,
       reacao, reacao_em
  FROM whatsapp_mensagens;

DROP TABLE whatsapp_mensagens;
ALTER TABLE whatsapp_mensagens_novo RENAME TO whatsapp_mensagens;

CREATE INDEX IF NOT EXISTS idx_wpp_mensagens_conversa
    ON whatsapp_mensagens(conversa_id, criado_em);
CREATE INDEX IF NOT EXISTS idx_msg_direcao_status
    ON whatsapp_mensagens(direcao, status);
CREATE INDEX IF NOT EXISTS idx_msg_conversa
    ON whatsapp_mensagens(conversa_id);

PRAGMA foreign_keys = ON;
