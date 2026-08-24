-- Lembrete e mensagem agendada também no chat interno.
--
-- As duas tabelas já existiam, mas amarradas a conversa de CLIENTE
-- (conversa_id NOT NULL). Em vez de criar tabelas paralelas (que
-- duplicariam o agendador, a tela e os alertas), a mesma linha passa a
-- apontar pra uma conversa de cliente OU pra uma interna.
--
-- SQLite não permite afrouxar um NOT NULL com ALTER TABLE, então as
-- tabelas são recriadas — por isso o cuidado de copiar os dados e
-- recriar os índices.

PRAGMA foreign_keys = OFF;

-- ---------- mensagens agendadas ----------
CREATE TABLE whatsapp_mensagens_agendadas_novo (
    id                      INTEGER PRIMARY KEY AUTOINCREMENT,
    conversa_id             INTEGER REFERENCES whatsapp_conversas(id),
    chat_interno_conversa_id INTEGER REFERENCES chat_interno_conversas(id),
    texto                   TEXT NOT NULL,
    agendado_para           TEXT NOT NULL,
    status                  TEXT NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente','enviada','cancelada','falhou')),
    erro                    TEXT,
    criado_por              INTEGER NOT NULL REFERENCES usuarios(id),
    criado_em               TEXT NOT NULL,
    tipo                    TEXT NOT NULL DEFAULT 'texto',
    midia_url               TEXT,
    nome_arquivo            TEXT,
    -- Uma coisa ou outra, nunca as duas nem nenhuma.
    CHECK ((conversa_id IS NOT NULL) <> (chat_interno_conversa_id IS NOT NULL))
);
INSERT INTO whatsapp_mensagens_agendadas_novo
    (id, conversa_id, texto, agendado_para, status, erro, criado_por, criado_em, tipo, midia_url, nome_arquivo)
SELECT id, conversa_id, texto, agendado_para, status, erro, criado_por, criado_em, tipo, midia_url, nome_arquivo
FROM whatsapp_mensagens_agendadas;
DROP TABLE whatsapp_mensagens_agendadas;
ALTER TABLE whatsapp_mensagens_agendadas_novo RENAME TO whatsapp_mensagens_agendadas;
CREATE INDEX idx_wpp_agendadas_pendentes ON whatsapp_mensagens_agendadas(status, agendado_para);

-- ---------- lembretes ----------
CREATE TABLE whatsapp_lembretes_novo (
    id                      INTEGER PRIMARY KEY AUTOINCREMENT,
    conversa_id             INTEGER REFERENCES whatsapp_conversas(id),
    chat_interno_conversa_id INTEGER REFERENCES chat_interno_conversas(id),
    usuario_id              INTEGER NOT NULL REFERENCES usuarios(id),
    texto                   TEXT,
    lembrar_em              TEXT NOT NULL,
    concluido               INTEGER NOT NULL DEFAULT 0 CHECK (concluido IN (0,1)),
    criado_por              INTEGER NOT NULL REFERENCES usuarios(id),
    criado_em               TEXT NOT NULL,
    CHECK ((conversa_id IS NOT NULL) <> (chat_interno_conversa_id IS NOT NULL))
);
INSERT INTO whatsapp_lembretes_novo
    (id, conversa_id, usuario_id, texto, lembrar_em, concluido, criado_por, criado_em)
SELECT id, conversa_id, usuario_id, texto, lembrar_em, concluido, criado_por, criado_em
FROM whatsapp_lembretes;
DROP TABLE whatsapp_lembretes;
ALTER TABLE whatsapp_lembretes_novo RENAME TO whatsapp_lembretes;
CREATE INDEX idx_wpp_lembretes_usuario ON whatsapp_lembretes(usuario_id, concluido, lembrar_em);

PRAGMA foreign_keys = ON;
