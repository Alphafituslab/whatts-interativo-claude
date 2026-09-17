-- Pedido do Clayton (2026-09-17): freio de ESPAÇAMENTO mínimo entre
-- abordagens frias (conversas iniciadas pela empresa com quem nunca
-- escreveu) -- diferente do limite_novos_contatos_hora (que é sobre
-- TOTAL na hora), esse é sobre INTERVALO entre uma e outra. Rastreado
-- como causa provável da queda do número 554834201881 em 16/09: 4
-- abordagens frias em ~5 minutos, mesmo bem abaixo do limite por hora.
ALTER TABLE configuracoes_whatsapp ADD COLUMN captacao_fria_intervalo_minimo_segundos INTEGER NOT NULL DEFAULT 90;
