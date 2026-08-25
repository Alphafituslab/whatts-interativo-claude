-- O nome que o WhatsApp manda (o que a própria pessoa pôs no perfil) passa
-- a ser gravado assim que chega, e a ficar em dia se ela mudar depois.
--
-- Esta coluna é o freio: quando alguém da equipe corrige o nome à mão, a
-- correção vence pra sempre. Sem ela, o atendente corrigia "Zé da oficina"
-- e a mensagem seguinte trazia de volta o apelido do perfil.
--
-- Os contatos que já existem começam com 0 de propósito: a maioria dos
-- nomes de hoje veio do próprio WhatsApp, e travá-los agora congelaria
-- justamente o que este recurso veio destravar. Quem for corrigido daqui
-- pra frente fica marcado.
ALTER TABLE whatsapp_contatos
    ADD COLUMN nome_editado INTEGER NOT NULL DEFAULT 0 CHECK (nome_editado IN (0, 1));
