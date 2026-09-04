-- Chamada de voz dentro do Chat interno (WebRTC direto entre os dois
-- navegadores -- o servidor só troca os "bilhetes" de sinalização,
-- nunca vê nem repassa o áudio). Pedido do Clayton (2026-09-04):
-- "e possivel implantar fazer chamadas de voz no chat interno? como
-- se eu estivesse fazendo uma ligação porem somente no chat interno".
--
-- Só 1 pra 1 (o chat interno já é sempre entre duas pessoas, sem
-- grupo). status: chamando -> atendida -> encerrada, ou chamando ->
-- recusada, ou chamando -> perdida (ninguém atendeu a tempo).
CREATE TABLE chat_interno_chamadas (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    conversa_id    INTEGER NOT NULL REFERENCES chat_interno_conversas(id),
    de_usuario_id  INTEGER NOT NULL REFERENCES usuarios(id),
    para_usuario_id INTEGER NOT NULL REFERENCES usuarios(id),
    status         TEXT NOT NULL DEFAULT 'chamando' CHECK (status IN ('chamando','atendida','recusada','perdida','encerrada')),
    criado_em      TEXT NOT NULL,
    atendida_em    TEXT,
    encerrada_em   TEXT,
    duracao_seg    INTEGER
);
CREATE INDEX idx_chamadas_conversa ON chat_interno_chamadas(conversa_id);
CREATE INDEX idx_chamadas_para_status ON chat_interno_chamadas(para_usuario_id, status);

-- Sinais WebRTC (oferta/resposta SDP e candidatos ICE) trocados
-- durante a chamada -- só enquanto ela está sendo montada; depois de
-- conectada, o áudio não passa mais por aqui.
CREATE TABLE chat_interno_chamadas_sinais (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    chamada_id    INTEGER NOT NULL REFERENCES chat_interno_chamadas(id) ON DELETE CASCADE,
    de_usuario_id INTEGER NOT NULL REFERENCES usuarios(id),
    tipo          TEXT NOT NULL CHECK (tipo IN ('oferta','resposta','candidato','encerrar')),
    dados         TEXT NOT NULL,
    criado_em     TEXT NOT NULL
);
CREATE INDEX idx_chamadas_sinais_chamada ON chat_interno_chamadas_sinais(chamada_id, id);
