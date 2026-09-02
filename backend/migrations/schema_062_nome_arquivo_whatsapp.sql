-- ============================================================
-- Nome original do arquivo, pro cliente saber o que é ao receber um
-- documento (pedido do Clayton, 2026-09-02) -- chat_interno_mensagens
-- e whatsapp_mensagens_agendadas já tinham essa coluna; faltava em
-- whatsapp_mensagens (a tabela principal das conversas de cliente).
-- ============================================================
ALTER TABLE whatsapp_mensagens ADD COLUMN nome_arquivo TEXT;
