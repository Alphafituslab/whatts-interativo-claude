-- ============================================================
-- Follow-up: nenhum cliente pode ser esquecido.
--
-- O sistema já avisava sobre conversa parada, mas em MINUTOS (SLA de
-- resposta rápida). Isto é outra coisa: acompanhar em DIAS se um
-- atendimento ficou sem retorno, com contato programado e adiamento.
--
-- Por que 'etapa' em vez de mexer no 'status': status é o estado
-- técnico (aberta/fechada) usado por todo o sistema, e trocar o CHECK
-- dele exigiria recriar a tabela inteira com dados reais dentro. 'etapa'
-- é a leitura comercial do atendimento, que é o que o follow-up olha.
-- ============================================================

ALTER TABLE whatsapp_conversas ADD COLUMN etapa TEXT NOT NULL DEFAULT 'novo';

-- Quem falou por último de cada lado. Dá pra descobrir consultando as
-- mensagens, mas guardar aqui evita varrer o histórico inteiro a cada
-- verificação de follow-up (que roda pra todas as conversas abertas).
ALTER TABLE whatsapp_conversas ADD COLUMN ultima_msg_cliente_em   TEXT;
ALTER TABLE whatsapp_conversas ADD COLUMN ultima_msg_operador_em  TEXT;

-- Próximo contato programado. Enquanto existir e não tiver vencido, a
-- conversa NÃO gera alerta de abandono (regra 15 da especificação).
ALTER TABLE whatsapp_conversas ADD COLUMN proximo_contato_em    TEXT;
ALTER TABLE whatsapp_conversas ADD COLUMN proximo_contato_forma TEXT;
ALTER TABLE whatsapp_conversas ADD COLUMN proximo_contato_obs   TEXT;

-- "Adiar" no alerta: silencia até esta data, sem virar um agendamento.
ALTER TABLE whatsapp_conversas ADD COLUMN followup_adiado_ate TEXT;

ALTER TABLE whatsapp_conversas ADD COLUMN prioridade TEXT NOT NULL DEFAULT 'normal';

-- Fechamento com responsável e motivo (antes só ficava a data).
ALTER TABLE whatsapp_conversas ADD COLUMN finalizada_por      INTEGER;
ALTER TABLE whatsapp_conversas ADD COLUMN motivo_finalizacao  TEXT;

-- Prazo padrão da empresa, em dias.
ALTER TABLE configuracoes_whatsapp ADD COLUMN followup_dias INTEGER NOT NULL DEFAULT 7;

-- Prazos diferentes por critério (setor, prioridade, etapa). O mais
-- específico ganha do padrão da empresa.
CREATE TABLE whatsapp_followup_prazos (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    empresa_id INTEGER NOT NULL,
    criterio   TEXT NOT NULL,   -- 'setor' | 'prioridade' | 'etapa'
    valor      TEXT NOT NULL,   -- ex.: 'Televendas', 'alta', 'aguardando_cliente'
    dias       INTEGER NOT NULL,
    criado_em  TEXT NOT NULL,
    UNIQUE(empresa_id, criterio, valor)
);

-- Histórico de tudo que acontece no follow-up — nunca apaga nada,
-- serve pra gestão e auditoria.
CREATE TABLE whatsapp_followup_historico (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    conversa_id INTEGER NOT NULL,
    usuario_id  INTEGER,
    acao        TEXT NOT NULL,   -- agendado | adiado | contatado | finalizado | reaberto | alerta_gerado
    detalhe     TEXT,
    criado_em   TEXT NOT NULL
);
CREATE INDEX idx_followup_hist_conversa ON whatsapp_followup_historico(conversa_id, criado_em);

-- Preenche o histórico que já existe: sem isso toda conversa antiga
-- apareceria como "nunca teve contato" no primeiro dia de uso.
UPDATE whatsapp_conversas SET ultima_msg_cliente_em = (
    SELECT MAX(m.criado_em) FROM whatsapp_mensagens m
    WHERE m.conversa_id = whatsapp_conversas.id AND m.direcao = 'entrada' AND m.excluida_em IS NULL
);
UPDATE whatsapp_conversas SET ultima_msg_operador_em = (
    SELECT MAX(m.criado_em) FROM whatsapp_mensagens m
    WHERE m.conversa_id = whatsapp_conversas.id AND m.direcao = 'saida' AND m.excluida_em IS NULL
);
UPDATE whatsapp_conversas SET etapa = 'finalizado' WHERE status = 'fechada';
UPDATE whatsapp_conversas SET etapa = 'em_atendimento'
    WHERE status = 'aberta' AND atribuida_usuario_id IS NOT NULL;
