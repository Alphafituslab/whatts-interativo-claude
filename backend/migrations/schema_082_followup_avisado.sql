-- "Avisar" no Follow-up (chamar atenção do responsável via chat
-- interno) marca este instante -- pedido do Clayton (2026-09-11):
-- depois de avisar, o item deve sumir do Follow-up de quem NÃO é o
-- responsável (quem já fez a parte dele de avisar não precisa ver de
-- novo); o responsável em si continua vendo normal, é o trabalho dele.
ALTER TABLE whatsapp_conversas ADD COLUMN followup_avisado_em TEXT;
