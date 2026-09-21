-- Pedido do Clayton (2026-09-21): freio de repetição pra anexo (foto,
-- vídeo, documento, áudio), igual já existe pra texto -- configurável.
-- "5 anexos ou pdfs iguais... somente após 30 minutos" -- quantidade E
-- janela de espera, as duas configuráveis.
--
-- midia_hash guarda o SHA-256 do CONTEÚDO do arquivo (não do nome, que
-- muda toda vez -- ver secrets.token_hex(8) no nome salvo) -- é assim
-- que dá pra saber que é "o mesmo anexo de novo", mesmo com nome
-- diferente a cada envio.
ALTER TABLE whatsapp_mensagens ADD COLUMN midia_hash TEXT;
CREATE INDEX idx_wpp_mensagens_midia_hash ON whatsapp_mensagens(midia_hash);

ALTER TABLE configuracoes_whatsapp ADD COLUMN limite_repeticao_anexo INTEGER NOT NULL DEFAULT 5;
ALTER TABLE configuracoes_whatsapp ADD COLUMN janela_repeticao_anexo_minutos INTEGER NOT NULL DEFAULT 30;
