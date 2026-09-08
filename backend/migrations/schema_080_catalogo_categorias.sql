-- Personalização de categorias do Catálogo/Proposta -- pedido do Clayton
-- (2026-09-08): menu inicial por categoria no catálogo público, com
-- ícone (e cor) de cada uma editável depois pelo admin. "categoria"
-- aqui é o mesmo texto livre que já existe em whatsapp_catalogo_itens.linha
-- -- esta tabela só guarda a personalização (ícone/cor) por nome; quando
-- não tem linha aqui, cai num ícone/cor padrão calculado automaticamente.
CREATE TABLE whatsapp_catalogo_categorias (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    empresa_id INTEGER NOT NULL REFERENCES empresas(id),
    nome       TEXT NOT NULL,
    icone      TEXT,
    cor        TEXT,
    criado_em  TEXT NOT NULL,
    UNIQUE(empresa_id, nome)
);
