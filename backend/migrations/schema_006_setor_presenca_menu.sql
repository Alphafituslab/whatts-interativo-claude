-- Setor do usuário (obrigatório na criação, de uma lista fixa).
ALTER TABLE usuarios ADD COLUMN setor TEXT;

-- Último acesso autenticado — usado pra saber quem está "online" agora
-- (dentro dos últimos minutos), pro menu de atendimento por setor só
-- oferecer gente disponível.
ALTER TABLE usuarios ADD COLUMN ultimo_acesso TEXT;

-- Menu automático de boas-vindas (setor -> atendente) oferecido pro
-- cliente na primeira mensagem de uma conversa nova.
ALTER TABLE whatsapp_conversas ADD COLUMN menu_estado TEXT;
ALTER TABLE whatsapp_conversas ADD COLUMN menu_opcoes TEXT;
ALTER TABLE whatsapp_conversas ADD COLUMN menu_setor TEXT;
