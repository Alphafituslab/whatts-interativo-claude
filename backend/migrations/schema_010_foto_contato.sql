-- Foto de perfil do WhatsApp do contato (cliente), buscada na Evolution
-- API assim que ele manda a primeira mensagem — pra quem assumir o
-- atendimento já ver quem é, sem precisar adivinhar pelas iniciais.
ALTER TABLE whatsapp_contatos ADD COLUMN foto_url TEXT;
ALTER TABLE whatsapp_contatos ADD COLUMN foto_atualizada_em TEXT;
