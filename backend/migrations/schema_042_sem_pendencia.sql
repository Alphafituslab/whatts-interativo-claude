-- "Não precisa responder": encerra a pendência sem mandar mensagem.
--
-- O alerta de atraso considera pendente toda conversa em que o cliente
-- falou por último. Isso obriga o atendente a SEMPRE ter a última
-- palavra — mesmo quando o cliente só mandou "ok, obrigado". Responder
-- por educação vira obrigação, e quem não responde acumula atraso que
-- não existe.
--
-- Com esta marca, a pessoa diz "vi, está resolvido" e a conversa sai do
-- alerta sem precisar de resposta. Guarda quem marcou e quando, porque
-- isso mexe no indicador de atraso do Dashboard e precisa ser
-- rastreável — senão viraria um jeito silencioso de esconder demora.
--
-- A marca é LIMPA sempre que o cliente fala de novo: aí é pendência
-- nova de verdade, e o alerta volta a valer.
ALTER TABLE whatsapp_conversas ADD COLUMN sem_pendencia_em TEXT;
ALTER TABLE whatsapp_conversas ADD COLUMN sem_pendencia_por INTEGER REFERENCES usuarios(id);
