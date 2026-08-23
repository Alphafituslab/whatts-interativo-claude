-- Logo da empresa, trocável pela tela de Configuração. Fica em data/
-- (fora do código) justamente pra sobreviver a atualização do sistema —
-- se ficasse junto dos arquivos do programa, cada atualização apagaria
-- a logo do cliente e voltaria a padrão.
ALTER TABLE configuracoes_whatsapp ADD COLUMN logo_url TEXT;
