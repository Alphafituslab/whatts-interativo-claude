-- Quem arquivou (pedido do Clayton, 2026-08-28): antes "arquivada" era
-- só um sim/não global na conversa, então TODO MUNDO que enxergava
-- aquela conversa (ex.: os membros de um grupo) via ela em "Arquivadas",
-- não importa quem clicou. Agora guarda quem foi, pra cada um ver só o
-- que ELE arquivou (admin continua vendo tudo).
ALTER TABLE whatsapp_conversas ADD COLUMN arquivada_por INTEGER REFERENCES usuarios(id);
