-- ============================================================
-- Resumo da conversa + Mensagens agendadas + Lembretes de retorno
-- ============================================================

-- Resumo curto e editável, escrito pelo operador — mostrado no topo da
-- conversa para quem abre não precisar reler tudo do zero para entender
-- o contexto (útil sobretudo depois de um "Encaminhar" para outra pessoa).
ALTER TABLE whatsapp_conversas ADD COLUMN resumo TEXT;

-- Mensagens agendadas para envio futuro. Um processo em segundo plano
-- (ver app/scheduler.py) verifica periodicamente quais estão vencidas
-- (agendado_para <= agora) e envia de verdade pela Evolution API,
-- exatamente como o envio manual — ver whatsapp_service.py.
CREATE TABLE whatsapp_mensagens_agendadas (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    conversa_id    INTEGER NOT NULL REFERENCES whatsapp_conversas(id),
    texto          TEXT NOT NULL,
    agendado_para  TEXT NOT NULL,
    status         TEXT NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente','enviada','cancelada','falhou')),
    erro           TEXT,
    criado_por     INTEGER NOT NULL REFERENCES usuarios(id),
    criado_em      TEXT NOT NULL
);
CREATE INDEX idx_wpp_agendadas_pendentes ON whatsapp_mensagens_agendadas(status, agendado_para);

-- Lembretes de retorno ("ligar/chamar de novo em tal data") — sempre
-- ligados a uma conversa e a UM usuário responsável por ser lembrado
-- (normalmente quem criou, mas pode ser delegado). O administrador vê
-- todos (mesma régua de "ver tudo" já usada nas conversas).
CREATE TABLE whatsapp_lembretes (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    conversa_id    INTEGER NOT NULL REFERENCES whatsapp_conversas(id),
    usuario_id     INTEGER NOT NULL REFERENCES usuarios(id),
    texto          TEXT,
    lembrar_em     TEXT NOT NULL,
    concluido      INTEGER NOT NULL DEFAULT 0 CHECK (concluido IN (0,1)),
    criado_por     INTEGER NOT NULL REFERENCES usuarios(id),
    criado_em      TEXT NOT NULL
);
CREATE INDEX idx_wpp_lembretes_usuario ON whatsapp_lembretes(usuario_id, concluido, lembrar_em);
