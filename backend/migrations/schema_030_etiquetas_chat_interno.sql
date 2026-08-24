-- Etiquetas também nas conversas do chat interno.
--
-- Reaproveita a MESMA tabela whatsapp_tags de propósito: a etiqueta é da
-- empresa ("Urgente", "Financeiro"), não do canal. Criar uma no chat
-- interno já a deixa disponível nas conversas de cliente e vice-versa —
-- duas listas separadas só dariam trabalho de manter sincronizadas.
CREATE TABLE chat_interno_conversa_tags (
    conversa_id  INTEGER NOT NULL REFERENCES chat_interno_conversas(id),
    tag_id       INTEGER NOT NULL REFERENCES whatsapp_tags(id),
    PRIMARY KEY (conversa_id, tag_id)
);
