-- Guarda QUEM apagou cada mensagem.
--
-- Hoje só ficava a data (excluida_em) e a mensagem sumia pra todo mundo.
-- O administrador precisa continuar vendo o que foi apagado e por quem —
-- é supervisão: sem isso, alguém pode apagar algo e não sobra registro
-- de quem foi. Ver routes/whatsapp.py::listar_mensagens.
ALTER TABLE whatsapp_mensagens ADD COLUMN excluida_por INTEGER;
ALTER TABLE chat_interno_mensagens ADD COLUMN excluida_por INTEGER;
