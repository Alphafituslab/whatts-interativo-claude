-- 2FA (TOTP) por usuário.
ALTER TABLE usuarios ADD COLUMN totp_secreto TEXT;
ALTER TABLE usuarios ADD COLUMN totp_ativado INTEGER NOT NULL DEFAULT 0;
ALTER TABLE usuarios ADD COLUMN totp_codigos_recuperacao TEXT;

-- Horário de funcionamento da empresa (fora dele, cliente recebe aviso
-- automático) e limiar de alerta de SLA (conversa parada há muito tempo).
ALTER TABLE configuracoes_whatsapp ADD COLUMN expediente_ativo INTEGER NOT NULL DEFAULT 0;
ALTER TABLE configuracoes_whatsapp ADD COLUMN expediente_janelas TEXT;
ALTER TABLE configuracoes_whatsapp ADD COLUMN expediente_mensagem TEXT;
ALTER TABLE configuracoes_whatsapp ADD COLUMN sla_minutos_alerta INTEGER NOT NULL DEFAULT 15;

-- Evita reenviar o aviso de "fora do expediente" a cada mensagem —
-- só manda de novo se fizer um tempo desde o último aviso nessa conversa.
ALTER TABLE whatsapp_conversas ADD COLUMN ultimo_aviso_expediente TEXT;

-- Respostas prontas (mensagens-modelo reutilizáveis).
CREATE TABLE whatsapp_respostas_prontas (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    atalho       TEXT NOT NULL UNIQUE,
    titulo       TEXT NOT NULL,
    texto        TEXT NOT NULL,
    criado_por   INTEGER REFERENCES usuarios(id),
    criado_em    TEXT NOT NULL
);

-- Notas internas por conversa — nunca enviadas ao cliente, só visíveis
-- pra equipe.
CREATE TABLE whatsapp_notas (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    conversa_id  INTEGER NOT NULL REFERENCES whatsapp_conversas(id),
    usuario_id   INTEGER REFERENCES usuarios(id),
    texto        TEXT NOT NULL,
    criado_em    TEXT NOT NULL
);
CREATE INDEX idx_wpp_notas_conversa ON whatsapp_notas(conversa_id, criado_em);

-- Etiquetas livres, além do setor.
CREATE TABLE whatsapp_tags (
    id     INTEGER PRIMARY KEY AUTOINCREMENT,
    nome   TEXT NOT NULL UNIQUE,
    cor    TEXT NOT NULL DEFAULT '#6b7280'
);
CREATE TABLE whatsapp_conversa_tags (
    conversa_id  INTEGER NOT NULL REFERENCES whatsapp_conversas(id),
    tag_id       INTEGER NOT NULL REFERENCES whatsapp_tags(id),
    PRIMARY KEY (conversa_id, tag_id)
);
