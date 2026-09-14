-- Clayton (2026-09-14): "me deixar apagar as mensagens dos contatos
-- monitorados por seleção e apagar para nao ficar ali sem ter
-- necessidade" -- não apaga a mensagem de verdade da conversa, só some
-- da tela de números monitorados (confirmado por ele: "deve apagar so
-- o numero monitorado e apagar apenas as mensagens selecionadas").
CREATE TABLE whatsapp_mensagens_monitoradas_ocultas (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    empresa_id       INTEGER NOT NULL REFERENCES empresas(id),
    mensagem_id      INTEGER NOT NULL REFERENCES whatsapp_mensagens(id),
    ocultada_em      TEXT NOT NULL,
    ocultada_por_id  INTEGER REFERENCES usuarios(id),
    UNIQUE(empresa_id, mensagem_id)
);
