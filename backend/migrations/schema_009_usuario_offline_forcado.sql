-- Permite marcar um usuário como offline manualmente (ex.: de férias,
-- afastado), mesmo que o token dele ainda esteja "recente" — isso o
-- tira das listas de "online" e da distribuição automática do menu
-- de setor.
ALTER TABLE usuarios ADD COLUMN offline_forcado INTEGER NOT NULL DEFAULT 0;
