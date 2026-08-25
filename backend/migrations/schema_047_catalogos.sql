-- Portfólio/catálogo que a equipe manda pro cliente.
--
-- Dois formatos, porque os dois existem na prática: o LINK (o portfólio
-- que já está no ar, sempre atualizado) e o PDF (tabela de preço, encarte
-- de campanha, catálogo de outra marca — o que não cabe no site).
--
-- "restrito" é o pedido do Clayton: nem todo mundo manda portfólio. Com
-- restrito = 0 qualquer atendente manda; com 1, só quem estiver na lista
-- de catalogo_usuarios. A escolha é por catálogo, não global — dá pra ter
-- o portfólio liberado geral e a tabela de preço só pra Televendas.
CREATE TABLE IF NOT EXISTS catalogos (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    empresa_id   INTEGER NOT NULL REFERENCES empresas(id),
    nome         TEXT NOT NULL,
    descricao    TEXT,
    tipo         TEXT NOT NULL CHECK (tipo IN ('link', 'pdf')),
    url          TEXT NOT NULL,
    nome_arquivo TEXT,
    restrito     INTEGER NOT NULL DEFAULT 0 CHECK (restrito IN (0, 1)),
    ativo        INTEGER NOT NULL DEFAULT 1 CHECK (ativo IN (0, 1)),
    ordem        INTEGER NOT NULL DEFAULT 0,
    criado_por   INTEGER REFERENCES usuarios(id),
    criado_em    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS catalogo_usuarios (
    catalogo_id INTEGER NOT NULL REFERENCES catalogos(id),
    usuario_id  INTEGER NOT NULL REFERENCES usuarios(id),
    PRIMARY KEY (catalogo_id, usuario_id)
);

CREATE INDEX IF NOT EXISTS idx_catalogos_empresa ON catalogos(empresa_id, ativo, ordem);
CREATE INDEX IF NOT EXISTS idx_catalogo_usuarios_usuario ON catalogo_usuarios(usuario_id);

-- Registro de cada envio: serve pra saber quem mandou o quê pra quem, e
-- pra não repetir o mesmo catálogo pro mesmo cliente sem perceber.
CREATE TABLE IF NOT EXISTS catalogo_envios (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    catalogo_id INTEGER NOT NULL REFERENCES catalogos(id),
    conversa_id INTEGER NOT NULL REFERENCES whatsapp_conversas(id),
    usuario_id  INTEGER NOT NULL REFERENCES usuarios(id),
    criado_em   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_catalogo_envios_conversa ON catalogo_envios(conversa_id);
