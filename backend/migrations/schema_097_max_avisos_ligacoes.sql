-- Pedido do Clayton (2026-09-18): configurar por quantos dias SEGUIDOS
-- o lembrete de "Próximo contato" (planilha de Ligações) deve avisar
-- todo dia, antes de parar de avisar sozinho (hoje avisa pra sempre,
-- todo santo dia, até alguém prorrogar ou mudar a data).
ALTER TABLE configuracoes_whatsapp ADD COLUMN max_avisos_ligacoes_seguidos INTEGER NOT NULL DEFAULT 5;
ALTER TABLE crm_ligacoes ADD COLUMN avisos_consecutivos INTEGER NOT NULL DEFAULT 0;
