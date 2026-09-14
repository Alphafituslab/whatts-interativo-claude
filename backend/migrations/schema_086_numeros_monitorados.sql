-- Numeros monitorados -- pedido do Clayton (2026-09-14): poder marcar
-- um numero de telefone pra ser avisado sempre que houver atividade
-- (mensagem, foto, video) naquela conversa, mesmo que a mensagem seja
-- apagada depois. Restrito a Master (mesma regra ja usada pra ver
-- conteudo apagado no chat interno).
ALTER TABLE configuracoes_whatsapp ADD COLUMN numeros_monitorados TEXT NOT NULL DEFAULT '[]';
