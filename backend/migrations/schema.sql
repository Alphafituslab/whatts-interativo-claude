-- ============================================================
-- WhatsApp Inbox — schema inicial
-- ============================================================
-- Sistema independente: login/senha próprios (sem depender do ERP
-- Alphafitus OS). Vários usuários podem logar; todos compartilham o
-- acesso a UM número de WhatsApp conectado (caixa de entrada única).

CREATE TABLE usuarios (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    nome          TEXT NOT NULL,
    email         TEXT NOT NULL UNIQUE,
    senha_hash    TEXT NOT NULL,
    admin         INTEGER NOT NULL DEFAULT 0 CHECK (admin IN (0,1)),
    ativo         INTEGER NOT NULL DEFAULT 1 CHECK (ativo IN (0,1)),
    criado_em     TEXT NOT NULL
);

-- Refresh tokens de sessão — guardados só como hash (nunca em texto
-- puro), com revogação individual (ex.: "sair" ou "encerrar sessão").
CREATE TABLE sessoes (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    usuario_id          INTEGER NOT NULL REFERENCES usuarios(id),
    refresh_token_hash  TEXT NOT NULL UNIQUE,
    criado_em           TEXT NOT NULL,
    dispositivo         TEXT,
    revogado            INTEGER NOT NULL DEFAULT 0 CHECK (revogado IN (0,1))
);

-- ============================================================
-- CONFIGURAÇÃO DA INSTÂNCIA (Evolution API — provedor não-oficial,
-- auto-hospedado; ver README.md para o porquê e o passo a passo).
-- ============================================================
CREATE TABLE configuracoes_whatsapp (
    id                   INTEGER PRIMARY KEY CHECK (id = 1),
    ativo                INTEGER NOT NULL DEFAULT 0 CHECK (ativo IN (0,1)),
    evolution_url        TEXT,
    evolution_apikey     TEXT,
    instancia_nome       TEXT NOT NULL DEFAULT 'whatts',
    webhook_segredo      TEXT,
    status_conexao       TEXT NOT NULL DEFAULT 'desconectado'
                         CHECK (status_conexao IN ('desconectado','aguardando_qrcode','conectado','erro')),
    numero_conectado     TEXT,
    qrcode_base64        TEXT,
    qrcode_atualizado_em TEXT,
    atualizado_em        TEXT,
    atualizado_por       INTEGER REFERENCES usuarios(id)
);
INSERT INTO configuracoes_whatsapp (id, ativo, instancia_nome, status_conexao)
VALUES (1, 0, 'whatts', 'desconectado');

CREATE TABLE whatsapp_contatos (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    telefone      TEXT NOT NULL UNIQUE,
    nome          TEXT,
    criado_em     TEXT NOT NULL,
    atualizado_em TEXT NOT NULL
);

CREATE TABLE whatsapp_conversas (
    id                      INTEGER PRIMARY KEY AUTOINCREMENT,
    contato_id              INTEGER NOT NULL REFERENCES whatsapp_contatos(id),
    status                  TEXT NOT NULL DEFAULT 'aberta' CHECK (status IN ('aberta','fechada')),
    atribuida_usuario_id    INTEGER REFERENCES usuarios(id),
    nao_lidas               INTEGER NOT NULL DEFAULT 0,
    ultima_mensagem_em      TEXT,
    ultima_mensagem_preview TEXT,
    criado_em               TEXT NOT NULL
);
CREATE INDEX idx_wpp_conversas_contato ON whatsapp_conversas(contato_id);
CREATE INDEX idx_wpp_conversas_ultima_mensagem ON whatsapp_conversas(ultima_mensagem_em DESC);

CREATE TABLE whatsapp_mensagens (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    conversa_id    INTEGER NOT NULL REFERENCES whatsapp_conversas(id),
    direcao        TEXT NOT NULL CHECK (direcao IN ('entrada','saida')),
    tipo           TEXT NOT NULL DEFAULT 'texto' CHECK (tipo IN ('texto','imagem','documento','audio','video','outro')),
    texto          TEXT,
    midia_url      TEXT,
    externo_id     TEXT UNIQUE,
    usuario_id     INTEGER REFERENCES usuarios(id),
    status         TEXT NOT NULL DEFAULT 'pendente'
                   CHECK (status IN ('pendente','enviada','entregue','lida','falhou','recebida')),
    erro           TEXT,
    criado_em      TEXT NOT NULL
);
CREATE INDEX idx_wpp_mensagens_conversa ON whatsapp_mensagens(conversa_id, criado_em);
