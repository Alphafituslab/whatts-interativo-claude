-- Historico de "negociação fechada" marcada numa conversa (pedido do
-- Clayton, 2026-08-27): cada clique em "Marcar negociação fechada" gera
-- um registro NOVO aqui -- nunca sobrescreve o anterior. É o que deixa
-- contar VÁRIAS vendas com o MESMO cliente ao longo do tempo (fechou em
-- janeiro, fechou de novo em março, cada uma conta separado). Também é
-- a base de dados que uma futura IA vendedora vai usar pra aprender
-- padrão de recompra (ver conversa sobre IA nesta sessão).
CREATE TABLE whatsapp_negociacoes_fechadas (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    conversa_id INTEGER NOT NULL REFERENCES whatsapp_conversas(id),
    contato_id  INTEGER NOT NULL REFERENCES whatsapp_contatos(id),
    usuario_id  INTEGER NOT NULL REFERENCES usuarios(id),
    empresa_id  INTEGER NOT NULL REFERENCES empresas(id),
    marcado_em  TEXT NOT NULL
);
CREATE INDEX idx_negociacoes_fechadas_conversa ON whatsapp_negociacoes_fechadas(conversa_id);
CREATE INDEX idx_negociacoes_fechadas_contato ON whatsapp_negociacoes_fechadas(contato_id);
CREATE INDEX idx_negociacoes_fechadas_usuario ON whatsapp_negociacoes_fechadas(usuario_id);
