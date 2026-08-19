-- ============================================================
-- MULTI-EMPRESA (multi-tenant) — primeira fase.
-- ============================================================
-- Introduz o conceito de "empresa" pra permitir vender o sistema pra mais
-- de um cliente, cada um com dados 100% isolados (usuários, contatos,
-- conversas, configuração de WhatsApp, tags, respostas prontas). Tudo
-- que já existe no banco é migrado pra uma "empresa 1" automaticamente —
-- ninguém perde nada, o sistema continua funcionando exatamente igual
-- pra quem já usa.
--
-- configuracoes_whatsapp, whatsapp_contatos, whatsapp_tags e
-- whatsapp_respostas_prontas precisam recriar a tabela (não só ADD
-- COLUMN) porque suas restrições UNIQUE/CHECK atuais são globais e
-- precisam virar "únicas dentro da empresa" — ex.: dois clientes de
-- empresas diferentes podem ter o mesmo número de telefone, hoje isso é
-- proibido pelo UNIQUE simples. Segue o procedimento oficial do SQLite
-- pra alterar esse tipo de restrição (12-step ALTER TABLE procedure).

CREATE TABLE empresas (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    nome       TEXT NOT NULL,
    ativo      INTEGER NOT NULL DEFAULT 1 CHECK (ativo IN (0,1)),
    criado_em  TEXT NOT NULL
);
INSERT INTO empresas (id, nome, ativo, criado_em) VALUES (1, 'Empresa padrão', 1, datetime('now'));

-- usuarios: sem restrição global pra trocar, só precisa da coluna nova.
-- (SQLite não deixa combinar REFERENCES com DEFAULT não-nulo num ADD
-- COLUMN — a referência à tabela empresas fica só de documentação, sem
-- enforcement, igual outras FKs adicionadas via ALTER neste projeto.)
ALTER TABLE usuarios ADD COLUMN empresa_id INTEGER NOT NULL DEFAULT 1;

PRAGMA foreign_keys = OFF;

-- ---- configuracoes_whatsapp: troca CHECK(id=1) por UNIQUE(empresa_id) ----
CREATE TABLE configuracoes_whatsapp_novo (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    empresa_id           INTEGER NOT NULL UNIQUE REFERENCES empresas(id),
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
    atualizado_por       INTEGER REFERENCES usuarios(id),
    webhook_base_url     TEXT,
    expediente_ativo     INTEGER NOT NULL DEFAULT 0,
    expediente_janelas   TEXT,
    expediente_mensagem  TEXT,
    sla_minutos_alerta   INTEGER NOT NULL DEFAULT 15
);
INSERT INTO configuracoes_whatsapp_novo
    (id, empresa_id, ativo, evolution_url, evolution_apikey, instancia_nome, webhook_segredo,
     status_conexao, numero_conectado, qrcode_base64, qrcode_atualizado_em, atualizado_em, atualizado_por,
     webhook_base_url, expediente_ativo, expediente_janelas, expediente_mensagem, sla_minutos_alerta)
SELECT id, 1, ativo, evolution_url, evolution_apikey, instancia_nome, webhook_segredo,
       status_conexao, numero_conectado, qrcode_base64, qrcode_atualizado_em, atualizado_em, atualizado_por,
       webhook_base_url, expediente_ativo, expediente_janelas, expediente_mensagem, sla_minutos_alerta
FROM configuracoes_whatsapp;
DROP TABLE configuracoes_whatsapp;
ALTER TABLE configuracoes_whatsapp_novo RENAME TO configuracoes_whatsapp;

-- ---- whatsapp_contatos: troca UNIQUE(telefone) por UNIQUE(empresa_id, telefone) ----
CREATE TABLE whatsapp_contatos_novo (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    empresa_id         INTEGER NOT NULL REFERENCES empresas(id),
    telefone           TEXT NOT NULL,
    nome               TEXT,
    criado_em          TEXT NOT NULL,
    atualizado_em      TEXT NOT NULL,
    foto_url           TEXT,
    foto_atualizada_em TEXT,
    UNIQUE (empresa_id, telefone)
);
INSERT INTO whatsapp_contatos_novo (id, empresa_id, telefone, nome, criado_em, atualizado_em, foto_url, foto_atualizada_em)
SELECT id, 1, telefone, nome, criado_em, atualizado_em, foto_url, foto_atualizada_em FROM whatsapp_contatos;
DROP TABLE whatsapp_contatos;
ALTER TABLE whatsapp_contatos_novo RENAME TO whatsapp_contatos;

-- ---- whatsapp_tags: troca UNIQUE(nome) por UNIQUE(empresa_id, nome) ----
CREATE TABLE whatsapp_tags_novo (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    empresa_id  INTEGER NOT NULL REFERENCES empresas(id),
    nome        TEXT NOT NULL,
    cor         TEXT NOT NULL DEFAULT '#6b7280',
    UNIQUE (empresa_id, nome)
);
INSERT INTO whatsapp_tags_novo (id, empresa_id, nome, cor) SELECT id, 1, nome, cor FROM whatsapp_tags;
DROP TABLE whatsapp_tags;
ALTER TABLE whatsapp_tags_novo RENAME TO whatsapp_tags;

-- ---- whatsapp_respostas_prontas: troca UNIQUE(atalho) por UNIQUE(empresa_id, atalho) ----
CREATE TABLE whatsapp_respostas_prontas_novo (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    empresa_id  INTEGER NOT NULL REFERENCES empresas(id),
    atalho      TEXT NOT NULL,
    titulo      TEXT NOT NULL,
    texto       TEXT NOT NULL,
    criado_por  INTEGER REFERENCES usuarios(id),
    criado_em   TEXT NOT NULL,
    UNIQUE (empresa_id, atalho)
);
INSERT INTO whatsapp_respostas_prontas_novo (id, empresa_id, atalho, titulo, texto, criado_por, criado_em)
SELECT id, 1, atalho, titulo, texto, criado_por, criado_em FROM whatsapp_respostas_prontas;
DROP TABLE whatsapp_respostas_prontas;
ALTER TABLE whatsapp_respostas_prontas_novo RENAME TO whatsapp_respostas_prontas;

PRAGMA foreign_key_check;
PRAGMA foreign_keys = ON;
