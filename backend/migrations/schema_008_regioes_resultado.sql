-- Resultado da negociação ao fechar a conversa — usado pro dashboard
-- calcular taxa de conversão em venda (por região, setor, usuário etc.).
-- NULL = fechada sem marcar resultado (comportamento antigo, continua
-- valendo pras conversas já fechadas antes desta migration).
ALTER TABLE whatsapp_conversas ADD COLUMN resultado TEXT;
