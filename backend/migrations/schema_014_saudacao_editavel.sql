-- Texto de saudação (antes do menu numerado de setores) editável pelo
-- admin em Configuração — antes era fixo no código.
ALTER TABLE configuracoes_whatsapp ADD COLUMN saudacao_mensagem TEXT;
