-- Catalogo interativo / montador de proposta -- Fase 1: cadastro dos
-- itens e faixas de preco pelo admin, ainda SEM tela pro cliente.
-- Pedido do Clayton (2026-09-04): "vamos construir, mas nao deixar
-- aparecer ainda para os usuarios, eu quero testar" + toggle em
-- Configuracoes pra liberar/nao liberar.
--
-- catalogo_proposta_ativo: controla se a FUTURA tela do cliente fica
-- acessivel (fase 2) -- desligado por padrao. O cadastro dos itens
-- (admin) fica sempre acessivel pra quem e admin, independente disso.
ALTER TABLE configuracoes_whatsapp ADD COLUMN catalogo_proposta_ativo INTEGER NOT NULL DEFAULT 0;

CREATE TABLE whatsapp_catalogo_itens (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    empresa_id    INTEGER NOT NULL REFERENCES empresas(id),
    nome          TEXT NOT NULL,
    forma         TEXT,
    linha         TEXT,
    descricao     TEXT,
    imagem_url    TEXT,
    ordem         INTEGER NOT NULL DEFAULT 0,
    ativo         INTEGER NOT NULL DEFAULT 1 CHECK (ativo IN (0,1)),
    criado_por    INTEGER REFERENCES usuarios(id),
    criado_em     TEXT NOT NULL,
    atualizado_em TEXT NOT NULL
);
CREATE INDEX idx_catalogo_itens_empresa ON whatsapp_catalogo_itens(empresa_id);

-- Faixa de quantidade -> preco daquele item. quantidade_max NULL = "em
-- diante" (sem teto), pra nao travar se um dia precisar de uma faixa
-- aberta no topo.
CREATE TABLE whatsapp_catalogo_faixas (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id        INTEGER NOT NULL REFERENCES whatsapp_catalogo_itens(id) ON DELETE CASCADE,
    quantidade_min INTEGER NOT NULL,
    quantidade_max INTEGER,
    preco          REAL NOT NULL,
    ordem          INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_catalogo_faixas_item ON whatsapp_catalogo_faixas(item_id);
