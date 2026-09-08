-- Chamar atenção mesmo com a aba minimizada -- pedido do Clayton
-- (2026-09-08): quem for chamado (chamada de voz no chat interno, ou
-- "chamar atenção") deve ver o aviso mesmo sem caixa de som e mesmo
-- com a tela minimizada/em outra aba -- "assim o usuário não pode
-- dizer que não viu". Usa a Notification API do navegador (clicar
-- nela restaura/foca a janela -- é o único jeito que o JS tem de
-- "acordar" uma janela minimizada, por segurança do próprio navegador).
ALTER TABLE configuracoes_whatsapp ADD COLUMN notificacao_desktop_ativo INTEGER NOT NULL DEFAULT 1;
ALTER TABLE configuracoes_whatsapp ADD COLUMN notificacao_desktop_usuarios_ocultos TEXT;
