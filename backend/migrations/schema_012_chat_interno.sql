-- Chat interno privado entre colaboradores/setores — completamente
-- separado das conversas de clientes (não usa a fila/menu de setor do
-- bot). Sempre 1-para-1: quem inicia escolhe um setor e um colaborador
-- específico daquele setor; só os dois (mais admin, mesma régua de
-- supervisão já usada nas conversas de clientes) veem a conversa. Pode
-- ser encaminhada pra outra pessoa/setor sem perder o histórico — troca
-- só quem está do lado "participante", quem iniciou nunca muda.
CREATE TABLE chat_interno_conversas (
    id                      INTEGER PRIMARY KEY AUTOINCREMENT,
    criado_por_id           INTEGER NOT NULL REFERENCES usuarios(id),
    participante_id         INTEGER REFERENCES usuarios(id),
    setor_destino           TEXT,
    status                  TEXT NOT NULL DEFAULT 'aberta' CHECK (status IN ('aberta','fechada')),
    nao_lidas_criador       INTEGER NOT NULL DEFAULT 0,
    nao_lidas_participante  INTEGER NOT NULL DEFAULT 0,
    criado_em               TEXT NOT NULL,
    ultima_mensagem_em      TEXT,
    ultima_mensagem_preview TEXT,
    fechada_em              TEXT
);
CREATE INDEX idx_chat_interno_criador ON chat_interno_conversas(criado_por_id, status);
CREATE INDEX idx_chat_interno_participante ON chat_interno_conversas(participante_id, status);

CREATE TABLE chat_interno_mensagens (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    conversa_id    INTEGER NOT NULL REFERENCES chat_interno_conversas(id),
    usuario_id     INTEGER NOT NULL REFERENCES usuarios(id),
    texto          TEXT,
    tipo           TEXT NOT NULL DEFAULT 'texto',
    midia_url      TEXT,
    nome_arquivo   TEXT,
    criado_em      TEXT NOT NULL
);
CREATE INDEX idx_chat_interno_mensagens_conversa ON chat_interno_mensagens(conversa_id, criado_em);

-- Histórico de encaminhamentos — mesmo raciocínio de whatsapp_atribuicoes:
-- registra quem passou a conversa pra quem, útil pra auditoria depois.
CREATE TABLE chat_interno_encaminhamentos (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    conversa_id     INTEGER NOT NULL REFERENCES chat_interno_conversas(id),
    de_usuario_id   INTEGER REFERENCES usuarios(id),
    para_usuario_id INTEGER REFERENCES usuarios(id),
    setor_destino   TEXT,
    encaminhado_por INTEGER NOT NULL REFERENCES usuarios(id),
    criado_em       TEXT NOT NULL
);
