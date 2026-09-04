-- Assistente de IA (Fase 1: infraestrutura, desligado por padrao).
-- Pedido do Clayton (2026-09-04): "podemos implantar a IA para ir
-- aprendendo no sistema, mas deixar que eu possa habilitar e
-- desabilitar quando eu desejar" + "AINDA NAO TENHO NADA, NAO QUERO
-- PAGAR AINDA, SO DEIXAR IMPLANTADO e quando decidir faremos" +
-- "Sim, comecar no modo sugestao (Recomendado)".
--
-- ia_ativa: liga/desliga geral -- so funciona se TAMBEM tiver
--   ia_api_key preenchida (sem key nao faz nenhuma chamada, custo zero).
-- ia_api_key: chave da API da Anthropic, guardada igual a
--   evolution_apikey (nunca volta pro frontend, so um booleano
--   "configurada" -- ver config_publica).
-- ia_modo: 'sugestao' (so sugere, atendente decide) por enquanto e o
--   unico modo -- coluna ja existe pra quando vierem os proximos
--   modos, sem precisar de nova migration.
ALTER TABLE configuracoes_whatsapp ADD COLUMN ia_ativa INTEGER NOT NULL DEFAULT 0;
ALTER TABLE configuracoes_whatsapp ADD COLUMN ia_api_key TEXT;
ALTER TABLE configuracoes_whatsapp ADD COLUMN ia_modo TEXT NOT NULL DEFAULT 'sugestao';
