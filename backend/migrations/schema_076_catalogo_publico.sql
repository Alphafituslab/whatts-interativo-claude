-- Catálogo/Proposta -- Fase 2: link público (sem login) pro cliente
-- escolher item + quantidade, ver o preço na hora e mandar de volta
-- pra conversa dele no WhatsApp já como proposta pronta.

-- Um link por conversa/momento de envio -- token aleatório (mesma ideia
-- do webhook_segredo), nunca o id da conversa exposto na URL.
CREATE TABLE whatsapp_catalogo_links (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    token       TEXT NOT NULL UNIQUE,
    conversa_id INTEGER NOT NULL REFERENCES whatsapp_conversas(id),
    empresa_id  INTEGER NOT NULL REFERENCES empresas(id),
    criado_por  INTEGER REFERENCES usuarios(id),
    criado_em   TEXT NOT NULL,
    expira_em   TEXT NOT NULL,
    usado_em    TEXT
);
CREATE INDEX idx_catalogo_links_token ON whatsapp_catalogo_links(token);

-- Registro do que o cliente efetivamente escolheu -- guarda um "retrato"
-- do nome/preço de cada item NA HORA da proposta (nome_item, preco_
-- unitario): se o Clayton mudar o preço do item depois, a proposta
-- antiga não pode mudar de valor sozinha.
CREATE TABLE whatsapp_catalogo_propostas (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    link_id     INTEGER NOT NULL REFERENCES whatsapp_catalogo_links(id),
    conversa_id INTEGER NOT NULL REFERENCES whatsapp_conversas(id),
    empresa_id  INTEGER NOT NULL REFERENCES empresas(id),
    total       REAL NOT NULL,
    criado_em   TEXT NOT NULL
);

CREATE TABLE whatsapp_catalogo_propostas_itens (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    proposta_id   INTEGER NOT NULL REFERENCES whatsapp_catalogo_propostas(id) ON DELETE CASCADE,
    item_id       INTEGER REFERENCES whatsapp_catalogo_itens(id),
    nome_item     TEXT NOT NULL,
    quantidade    INTEGER NOT NULL,
    preco_unitario REAL NOT NULL,
    subtotal      REAL NOT NULL
);
CREATE INDEX idx_catalogo_propostas_itens_proposta ON whatsapp_catalogo_propostas_itens(proposta_id);
