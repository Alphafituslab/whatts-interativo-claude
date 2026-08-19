-- ============================================================
-- Atribuição por fila + histórico + fechamento de conversa
-- ============================================================
-- Contexto: até aqui a caixa de entrada era 100% compartilhada (qualquer
-- usuário via/respondia qualquer conversa). Esta migration passa a
-- restringir: cada usuário só vê as conversas ATRIBUÍDAS a ele; uma
-- conversa nova (sem atribuição ainda) fica numa "fila" visível a todos
-- até alguém assumir ("Assumir") ou o administrador atribuir a alguém
-- ("Encaminhar"). O administrador continua vendo tudo, mas ver uma
-- conversa de outro usuário no modo supervisão NÃO zera o contador de
-- não lidas dele (só zera quando o próprio dono abre) — ver app/
-- routes/whatsapp.py.

-- Quando a conversa foi fechada — usado para calcular o tempo médio de
-- atendimento no dashboard (sem isso não dava pra saber QUANDO ela
-- fechou, só que estava fechada).
ALTER TABLE whatsapp_conversas ADD COLUMN fechada_em TEXT;

-- Histórico de atribuições — cada linha é uma "passagem de bastão".
-- usuario_id NULL representa "voltou para a fila" (ex.: ninguém
-- assumiu ainda, ou foi devolvida). Serve tanto de auditoria (quem
-- encaminhou pra quem e quando) quanto de base para o dashboard medir
-- quanto tempo cada usuário realmente ficou responsável por cada
-- conversa (relevante quando uma conversa passa por mais de um usuário).
CREATE TABLE whatsapp_atribuicoes (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    conversa_id    INTEGER NOT NULL REFERENCES whatsapp_conversas(id),
    usuario_id     INTEGER REFERENCES usuarios(id),
    atribuido_por  INTEGER REFERENCES usuarios(id),
    criado_em      TEXT NOT NULL
);
CREATE INDEX idx_wpp_atribuicoes_conversa ON whatsapp_atribuicoes(conversa_id, criado_em);
