-- Feriados/datas sem funcionamento -- pedido do Clayton (2026-09-07):
-- "quando for feriado na cidade e não estivermos em funcionamento me
-- deixar colocar um aviso sobre isso".
--
-- Independente do "Horário de funcionamento" (expediente_ativo) --
-- funciona mesmo se ele estiver desligado: um feriado cadastrado pra
-- hoje sempre conta como "fora do expediente" pra quem escrever.
CREATE TABLE whatsapp_feriados (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    empresa_id INTEGER NOT NULL REFERENCES empresas(id),
    data       TEXT NOT NULL,  -- "AAAA-MM-DD"
    descricao  TEXT NOT NULL,  -- ex.: "Aniversário da cidade"
    mensagem   TEXT,           -- opcional -- se vazio, usa uma mensagem padrão com a descrição
    criado_por INTEGER REFERENCES usuarios(id),
    criado_em  TEXT NOT NULL
);
CREATE INDEX idx_feriados_empresa_data ON whatsapp_feriados(empresa_id, data);
