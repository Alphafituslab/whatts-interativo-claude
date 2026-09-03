-- ============================================================
-- Lembrete de "entrar em contato novamente" na planilha de Ligações --
-- pedido do Clayton (2026-09-03): marcar uma data pra ligar de novo
-- pro cliente, e o Assistente Seja Alpha avisar no chat interno
-- quando chegar o dia, com opção de prorrogar o aviso.
-- ============================================================
ALTER TABLE crm_ligacoes ADD COLUMN proximo_contato_em TEXT;
ALTER TABLE crm_ligacoes ADD COLUMN aviso_enviado_em TEXT;
ALTER TABLE crm_ligacoes ADD COLUMN vezes_prorrogado INTEGER NOT NULL DEFAULT 0;

ALTER TABLE configuracoes_whatsapp ADD COLUMN aviso_ligacoes_ativo INTEGER NOT NULL DEFAULT 0 CHECK (aviso_ligacoes_ativo IN (0,1));
ALTER TABLE configuracoes_whatsapp ADD COLUMN dias_prorrogar_ligacao INTEGER NOT NULL DEFAULT 3;
