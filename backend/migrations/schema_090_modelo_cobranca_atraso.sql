-- Clayton (2026-09-14): ao clicar na lupa do "pior atendimento" e ver
-- os clientes com atraso, poder cobrar explicacao do atendente
-- diretamente pelo chat interno, saindo como o Assistente. Frase
-- configuravel por ele (placeholders {cliente}, {tempo}).
ALTER TABLE configuracoes_whatsapp ADD COLUMN modelo_cobranca_atraso TEXT;
