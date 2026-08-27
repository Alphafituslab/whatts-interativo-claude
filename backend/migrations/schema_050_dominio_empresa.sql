-- Endereço próprio de cada empresa cliente (ex.: empresax.sejaalpha.com.br,
-- ou um domínio totalmente dela). É o que deixa a tela de login mostrar a
-- LOGO CERTA antes mesmo de a pessoa digitar o email — o sistema decide
-- pelo endereço que ela usou pra entrar.
--
-- Fica NULL pra empresa que não tem domínio próprio ainda (o caso de
-- hoje: uma empresa só, acessando pelo domínio principal).
ALTER TABLE empresas ADD COLUMN dominio TEXT;

CREATE UNIQUE INDEX idx_empresas_dominio ON empresas(dominio) WHERE dominio IS NOT NULL;
