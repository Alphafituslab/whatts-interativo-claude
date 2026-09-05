-- Pedido do Clayton (2026-09-05): "quero ter autonomia de ocultar
-- qualquer menu desse aos outros usuários" -- interruptor GERAL (vale
-- pra todos os usuários não-admin igual), não por pessoa. Admin/Master
-- sempre vê o menu inteiro, independente disso -- é controle sobre o
-- que os OUTROS veem.
--
-- Lista em JSON (as "chave" de cada item de ITENS_MENU no frontend),
-- não uma coluna por item: novos itens de menu no futuro não exigem
-- nova migration pra virarem ocultáveis.
ALTER TABLE configuracoes_whatsapp ADD COLUMN menu_itens_ocultos TEXT NOT NULL DEFAULT '[]';
