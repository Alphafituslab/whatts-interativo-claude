-- Pedido do Clayton (2026-09-17): evitar gerar QR Code atrás de QR Code
-- sem intervalo (foi o que contribuiu pro bloqueio temporário de
-- pareamento sofrido no número 554834201881) -- agora limitado a 3
-- tentativas seguidas, com 5 minutos de espera pra liberar de novo.
ALTER TABLE configuracoes_whatsapp ADD COLUMN qr_tentativas INTEGER NOT NULL DEFAULT 0;
ALTER TABLE configuracoes_whatsapp ADD COLUMN qr_janela_inicio TEXT;
