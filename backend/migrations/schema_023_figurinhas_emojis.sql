-- Banco de figurinhas e emojis da empresa, que cresce com o uso.
--
-- Figurinha: quando um cliente manda uma, o atendente pode guardar pra
-- reusar depois. Guarda só a URL do arquivo que já foi salvo em
-- data/uploads pelo webhook — não duplica o arquivo.
CREATE TABLE whatsapp_figurinhas (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    empresa_id  INTEGER NOT NULL,
    midia_url   TEXT NOT NULL,
    descricao   TEXT,
    criado_por  INTEGER,
    criado_em   TEXT NOT NULL,
    UNIQUE(empresa_id, midia_url)
);

-- Emojis que a empresa adicionou além da lista padrão do sistema.
CREATE TABLE whatsapp_emojis (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    empresa_id  INTEGER NOT NULL,
    emoji       TEXT NOT NULL,
    criado_por  INTEGER,
    criado_em   TEXT NOT NULL,
    UNIQUE(empresa_id, emoji)
);
