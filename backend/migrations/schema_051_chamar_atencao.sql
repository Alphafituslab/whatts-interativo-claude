-- Botão "chamar atenção" no chat interno (pedido do Clayton, 2026-08-27):
-- toque sonoro insistente pro colega, repetível quantas vezes precisar
-- até ele responder. Guarda só o instante do último toque de CADA
-- lado — repetir o clique atualiza o instante, e é essa mudança que o
-- polling do destinatário detecta pra tocar o alerta de novo.
ALTER TABLE chat_interno_conversas ADD COLUMN aviso_criador_em TEXT;
ALTER TABLE chat_interno_conversas ADD COLUMN aviso_participante_em TEXT;
