-- Clayton (2026-09-14): "SLA com alerta ANTES de estourar, nao so
-- depois". Quantos minutos antes do prazo combinado ja avisar.
ALTER TABLE configuracoes_whatsapp ADD COLUMN sla_minutos_pre_alerta INTEGER NOT NULL DEFAULT 5;
