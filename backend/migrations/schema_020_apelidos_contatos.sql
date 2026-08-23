-- Cada atendente pode dar seu próprio nome pra um contato — só ele vê
-- esse nome. O nome "oficial" do contato (whatsapp_contatos.nome, que
-- vem do próprio WhatsApp ou da importação) continua intacto pros
-- outros. Mesma ideia do usuarios_apelidos, mas pra contato de cliente.
CREATE TABLE whatsapp_contatos_apelidos (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    usuario_id    INTEGER NOT NULL,
    contato_id    INTEGER NOT NULL,
    apelido       TEXT NOT NULL,
    atualizado_em TEXT NOT NULL,
    UNIQUE(usuario_id, contato_id)
);
