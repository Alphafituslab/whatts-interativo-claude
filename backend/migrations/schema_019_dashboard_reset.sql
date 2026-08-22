-- Permite "zerar" os contadores do Dashboard (Na fila, Conversas
-- abertas/fechadas, mensagens, avaliações) sem apagar nenhuma conversa
-- ou mensagem real — só marca a partir de quando contar de novo. Ver
-- whatsapp_service.py::calcular_dashboard / resetar_dashboard.
ALTER TABLE configuracoes_whatsapp ADD COLUMN dashboard_reset_em TEXT;
