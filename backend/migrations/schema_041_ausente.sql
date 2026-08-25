-- "Ausente no momento": a própria pessoa avisa que saiu.
--
-- Já existia offline_forcado, mas ele é do ADMIN — serve pra tirar
-- alguém de férias ou afastado das listas. Isto aqui é diferente: é a
-- pessoa dizendo "saí pro almoço, volto já", sem precisar deslogar nem
-- pedir pra ninguém.
--
-- Fica separado de propósito. Se fosse o mesmo campo, o admin poderia
-- desmarcar sem querer a ausência que a pessoa pôs, ou o contrário — e
-- os dois significam coisas diferentes na tela.
ALTER TABLE usuarios ADD COLUMN ausente INTEGER NOT NULL DEFAULT 0
    CHECK (ausente IN (0, 1));
ALTER TABLE usuarios ADD COLUMN ausente_ate TEXT;
ALTER TABLE usuarios ADD COLUMN ausente_motivo TEXT;
