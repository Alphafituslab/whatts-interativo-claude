-- Separa "admin da empresa" de "dono da plataforma".
--
-- Backup/restauração mexem no banco INTEIRO (todas as empresas de uma
-- vez), então não podem ficar liberados pra qualquer admin: o admin da
-- empresa B baixaria os dados da empresa A, ou restauraria um backup
-- apagando o que a empresa A criou depois. Só quem opera a plataforma
-- (a Alphafitus, empresa 1) pode fazer isso.
ALTER TABLE usuarios ADD COLUMN super_admin INTEGER NOT NULL DEFAULT 0 CHECK (super_admin IN (0,1));

UPDATE usuarios SET super_admin = 1 WHERE admin = 1 AND empresa_id = 1;
