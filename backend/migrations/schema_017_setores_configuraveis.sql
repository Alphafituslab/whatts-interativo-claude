-- Os setores (Televendas, Financeiro etc.) deixam de ser uma lista fixa no
-- código e passam a ser cadastro por empresa, editável em Configuração
-- (criar, renomear, excluir) — ver whatsapp_service.py::obter_setores.
CREATE TABLE whatsapp_setores (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    empresa_id INTEGER NOT NULL,
    nome       TEXT NOT NULL,
    ordem      INTEGER NOT NULL DEFAULT 0,
    criado_em  TEXT NOT NULL,
    UNIQUE(empresa_id, nome)
);

-- Semeia, pra cada empresa que já existe, os mesmos setores que antes
-- eram fixos no código — na mesma ordem, pra não mudar o número que o
-- cliente já usa no menu ("digite 1, 2, 3...").
INSERT INTO whatsapp_setores (empresa_id, nome, ordem, criado_em)
SELECT e.id, s.nome, s.ordem, datetime('now')
FROM empresas e
CROSS JOIN (
    SELECT 0 AS ordem, 'Televendas' AS nome UNION ALL
    SELECT 1, 'Financeiro' UNION ALL
    SELECT 2, 'Faturamento' UNION ALL
    SELECT 3, 'Compras' UNION ALL
    SELECT 4, 'RH' UNION ALL
    SELECT 5, 'PCP' UNION ALL
    SELECT 6, 'Almoxarifado' UNION ALL
    SELECT 7, 'Laboratório' UNION ALL
    SELECT 8, 'Microbiológico' UNION ALL
    SELECT 9, 'Marketing' UNION ALL
    SELECT 10, 'Controladoria'
) s;
