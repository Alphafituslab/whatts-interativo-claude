-- Conta quantas vezes o cliente respondeu o menu de setor com algo que
-- não é um número válido — depois de 2 tentativas erradas, o sistema
-- desiste de pedir de novo e já transfere pra Televendas (ver
-- whatsapp_service.py::_tratar_resposta_menu).
ALTER TABLE whatsapp_conversas ADD COLUMN menu_tentativas_invalidas INTEGER NOT NULL DEFAULT 0;
