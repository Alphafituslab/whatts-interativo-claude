-- Guarda quem pediu a troca (se foi pedido por alguém que não é
-- admin) -- é o que deixa o sistema avisar de volta "já foi alterado"
-- pra essa pessoa quando o admin de fato trocar (pedido do Clayton,
-- 2026-08-28).
ALTER TABLE whatsapp_negociacoes_fechadas ADD COLUMN solicitado_por_id INTEGER REFERENCES usuarios(id);
