-- "Assinar mensagens": quando ligado, toda mensagem de texto que um
-- atendente manda ganha o nome dele na frente (ex.: "*Andreia:*\n..."),
-- pro CLIENTE saber quem está falando -- o WhatsApp em si não mostra
-- isso (o cliente só vê o número/perfil da empresa, nunca qual
-- funcionário mandou). Desligado por padrão: quem já tem o costume de
-- assinar na mão (ou não quer) não é afetado sem pedir.
ALTER TABLE configuracoes_whatsapp ADD COLUMN assinar_mensagens INTEGER NOT NULL DEFAULT 0;
