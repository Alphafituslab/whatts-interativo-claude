-- Segunda chave de IA -- Clayton pediu espaço pra chave do ChatGPT
-- (OpenAI) tambem, alem da Anthropic ja existente (schema_070).
-- Guardada do mesmo jeito: nunca volta crua pro frontend.
ALTER TABLE configuracoes_whatsapp ADD COLUMN ia_openai_api_key TEXT;
