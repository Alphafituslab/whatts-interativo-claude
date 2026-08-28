-- Localização padrão da empresa (pedido do Clayton, 2026-08-28) --
-- pra poder compartilhar com um clique quando o cliente pedir o
-- endereço, sem digitar toda vez. Cadastrada uma vez em Configuração.
ALTER TABLE configuracoes_whatsapp ADD COLUMN localizacao_nome TEXT;
ALTER TABLE configuracoes_whatsapp ADD COLUMN localizacao_endereco TEXT;
ALTER TABLE configuracoes_whatsapp ADD COLUMN localizacao_lat REAL;
ALTER TABLE configuracoes_whatsapp ADD COLUMN localizacao_lng REAL;
