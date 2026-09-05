-- Catálogo: galeria de várias fotos por item (era só uma) + campo de
-- complemento opcional. Pedido do Clayton (2026-09-05), depois de
-- mandar um print de loja com galeria de fotos: "ao colocar mais de
-- uma imagem ela deverá ficar assim [galeria]... nesses espaços em
-- branco deixar configurável pra colocar mais informações depois, mas
-- só aparecer se for configurado".
--
-- imagem_url (coluna já existente) continua servindo de capa/miniatura
-- na listagem do admin -- itens cadastrados antes desta migration não
-- perdem a foto. A galeria é tabela à parte porque o número de fotos
-- varia por produto (às vezes 1, às vezes 6+, como no print).
-- tipo: 'imagem' ou 'video' -- pedido do Clayton: "se for um vídeo
-- deixar também". Decidido pela extensão do arquivo na hora de salvar,
-- não perguntado pra pessoa (menos campo pra preencher à toa).
CREATE TABLE whatsapp_catalogo_imagens (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id INTEGER NOT NULL REFERENCES whatsapp_catalogo_itens(id) ON DELETE CASCADE,
    url     TEXT NOT NULL,
    tipo    TEXT NOT NULL DEFAULT 'imagem' CHECK (tipo IN ('imagem', 'video')),
    ordem   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_catalogo_imagens_item ON whatsapp_catalogo_imagens(item_id);

-- "Complementos do produto" -- bloco de texto livre e OPCIONAL que só
-- aparece na página do cliente se o Clayton preencher algo (nunca um
-- espaço vazio "programado" por padrão).
ALTER TABLE whatsapp_catalogo_itens ADD COLUMN complemento TEXT;
