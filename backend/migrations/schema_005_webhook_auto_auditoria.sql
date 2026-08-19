-- Base URL usada para registrar o webhook automaticamente na Evolution API
-- toda vez que conectar (evita perder o recebimento de mensagens quando a
-- instância é recriada num ciclo desconectar/reconectar).
ALTER TABLE configuracoes_whatsapp ADD COLUMN webhook_base_url TEXT;

-- Arquivamento e exclusão (lógica) de conversas.
ALTER TABLE whatsapp_conversas ADD COLUMN arquivada INTEGER NOT NULL DEFAULT 0;
ALTER TABLE whatsapp_conversas ADD COLUMN excluida_em TEXT;

-- Exclusão (lógica) de uma mensagem individual — ex.: mandada pro
-- cliente errado por engano.
ALTER TABLE whatsapp_mensagens ADD COLUMN excluida_em TEXT;

-- Foto de perfil do usuário.
ALTER TABLE usuarios ADD COLUMN foto_perfil TEXT;

-- Janelas de horário em que o usuário pode fazer login, como JSON:
-- '[{"inicio":"08:00","fim":"12:00"},{"inicio":"13:00","fim":"17:00"}]'.
-- NULL/vazio = sem restrição (login liberado a qualquer hora).
ALTER TABLE usuarios ADD COLUMN horario_permitido TEXT;

-- Rastro de atividades por usuário, visível pro administrador.
CREATE TABLE whatsapp_atividades (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    usuario_id    INTEGER REFERENCES usuarios(id),
    tipo          TEXT NOT NULL,
    descricao     TEXT,
    conversa_id   INTEGER REFERENCES whatsapp_conversas(id),
    criado_em     TEXT NOT NULL
);
CREATE INDEX idx_whatsapp_atividades_usuario ON whatsapp_atividades(usuario_id, criado_em);
CREATE INDEX idx_whatsapp_atividades_conversa ON whatsapp_atividades(conversa_id);
