-- ============================================================
-- Avaliação do cliente ao final do atendimento
-- ============================================================
-- Ao fechar uma conversa (POST /conversas/<id>/fechar), o sistema manda
-- uma mensagem automática pro CLIENTE pedindo uma nota de 1 a 5 e um
-- comentário livre. `aguardando_avaliacao=1` marca que a PRÓXIMA
-- mensagem que chegar desse contato deve ser interpretada como a
-- resposta dessa pesquisa (não como uma mensagem normal que reabre a
-- conversa) — ver whatsapp_service.py::_processar_mensagem_recebida.
ALTER TABLE whatsapp_conversas ADD COLUMN aguardando_avaliacao INTEGER NOT NULL DEFAULT 0 CHECK (aguardando_avaliacao IN (0,1));

-- Uma avaliação por conversa (UNIQUE conversa_id) — se o cliente
-- responder de novo depois, a mais recente sobrescreve (ver
-- whatsapp_service.py::registrar_avaliacao, usa INSERT...ON CONFLICT).
-- `usuario_id` é quem estava responsável pela conversa NO MOMENTO em
-- que ela foi fechada — guardado explicitamente (não é só um JOIN
-- futuro com whatsapp_conversas.atribuida_usuario_id) porque a
-- atribuição pode mudar depois (reaberta e encaminhada) sem que isso
-- deva alterar de quem foi a avaliação já registrada.
CREATE TABLE whatsapp_avaliacoes (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    conversa_id  INTEGER NOT NULL UNIQUE REFERENCES whatsapp_conversas(id),
    usuario_id   INTEGER REFERENCES usuarios(id),
    nota         INTEGER NOT NULL CHECK (nota BETWEEN 1 AND 5),
    comentario   TEXT,
    criado_em    TEXT NOT NULL
);
CREATE INDEX idx_wpp_avaliacoes_usuario ON whatsapp_avaliacoes(usuario_id);
