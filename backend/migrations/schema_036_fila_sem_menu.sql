-- Cliente que não escolheu nenhum número do menu não pode ficar
-- esquecido.
--
-- Até agora, conversa sem setor definido só o administrador via — a
-- ideia era não deixar gente de qualquer área pegar conversa que ainda
-- não se sabe pra onde vai. Só que quem simplesmente não responde o
-- menu (e é gente demais) ficava invisível pra equipe inteira,
-- esperando indefinidamente.
--
-- Agora, passados alguns minutos sem escolha nenhuma, a conversa entra
-- na fila de TODOS os atendentes, até alguém assumir. O tempo é
-- configurável porque depende do ritmo de cada empresa.
ALTER TABLE configuracoes_whatsapp
    ADD COLUMN minutos_liberar_sem_menu INTEGER NOT NULL DEFAULT 2;
