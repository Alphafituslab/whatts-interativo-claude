-- Freio de ritmo de envio, pra reduzir o risco de o número ser marcado
-- como robô e bloqueado pelo WhatsApp.
--
-- Já existia proteção contra a MESMA mensagem repetida (5 em 1 hora).
-- Faltava o volume: mandar 200 mensagens em cinco minutos é o padrão que
-- derruba número, mesmo com textos diferentes.
--
-- Fica configurável porque o número certo depende da operação: uma
-- equipe de dez atendendo o dia inteiro manda muito mais que uma de dois,
-- e um limite baixo demais atrapalha o trabalho de verdade.
ALTER TABLE configuracoes_whatsapp ADD COLUMN limite_envios_minuto INTEGER NOT NULL DEFAULT 20;
ALTER TABLE configuracoes_whatsapp ADD COLUMN limite_envios_hora INTEGER NOT NULL DEFAULT 250;

-- O mais perigoso de todos: escrever pra quem NUNCA falou com a gente.
-- É disso que vem a denúncia de spam, e denúncia é o que de fato derruba
-- um número. Por isso tem um limite próprio, bem mais apertado.
ALTER TABLE configuracoes_whatsapp ADD COLUMN limite_novos_contatos_hora INTEGER NOT NULL DEFAULT 20;
