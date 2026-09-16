-- Clayton (2026-09-16): opcao "Nao encerrar este cliente" por
-- conversa, configuravel por setor -- pra clientes que por natureza
-- sempre vao ter atendimento continuo (ex.: Faturamento). Quando
-- marcada, a conversa nao conta como "pior atendimento" no Dashboard
-- nem dispara alerta de SLA/conversa parada -- e proposital, nao
-- negligencia.
ALTER TABLE whatsapp_conversas ADD COLUMN nao_finalizar_ativo INTEGER NOT NULL DEFAULT 0;
ALTER TABLE whatsapp_conversas ADD COLUMN nao_finalizar_em TEXT;
ALTER TABLE whatsapp_conversas ADD COLUMN nao_finalizar_por INTEGER REFERENCES usuarios(id);

-- Quais setores tem essa opcao disponivel no menu -- admin decide.
ALTER TABLE configuracoes_whatsapp ADD COLUMN setores_nao_finalizar TEXT NOT NULL DEFAULT '[]';
