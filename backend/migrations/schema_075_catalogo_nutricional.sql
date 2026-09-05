-- Amplia o cadastro do catálogo (Fase 1) com o que aparece no modelo
-- de portifólio que o Clayton mandou: sabor, porção, informação
-- nutricional (tabela variável por produto), lista de ingredientes e
-- modo de uso. Pedido: "ter a opção também no cadastro de importar a
-- tabela nutricional" + "quero ir colocando mais e mais fórmulas...
-- os layouts tem que ficar tudo igual" -- por isso os nutrientes ficam
-- em tabela própria (linhas livres por produto), não colunas fixas:
-- cada suplemento tem um conjunto diferente de nutrientes na tabela
-- (creatina só tem "Creatina (mg)", um polivitamínico tem uma dúzia de
-- linhas), então colunas fixas quebrariam ou ficariam cheias de vazio.
ALTER TABLE whatsapp_catalogo_itens ADD COLUMN sabor TEXT;
ALTER TABLE whatsapp_catalogo_itens ADD COLUMN porcao TEXT;
ALTER TABLE whatsapp_catalogo_itens ADD COLUMN ingredientes TEXT;
ALTER TABLE whatsapp_catalogo_itens ADD COLUMN modo_de_uso TEXT;
ALTER TABLE whatsapp_catalogo_itens ADD COLUMN observacao_nutricional TEXT;

-- Uma linha da tabela "INFORMAÇÃO NUTRICIONAL" (ex.: "Creatina (mg)" |
-- "3000" | "**"). quantidade e vd ficam como texto (não número) porque
-- aparecem coisas como "**" e "314%" nas duas colunas do PDF modelo.
CREATE TABLE whatsapp_catalogo_nutrientes (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id  INTEGER NOT NULL REFERENCES whatsapp_catalogo_itens(id) ON DELETE CASCADE,
    nome     TEXT NOT NULL,
    quantidade TEXT,
    vd       TEXT,
    ordem    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_catalogo_nutrientes_item ON whatsapp_catalogo_nutrientes(item_id);
