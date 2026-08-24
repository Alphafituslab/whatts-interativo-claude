# Coisas que ficam fora do app Flask

## `downloads/index.html`

Página central de downloads da Alphafitus (Alphafitus OS + Whatts Inbox +
ferramenta de banco). Não é servida pelo Flask: o Caddy entrega ela direto
do disco, de `/opt/alphafitus-downloads`, e exige senha (basic auth).

Fica versionada aqui porque mora numa pasta fora do repositório no
servidor — sem isso, uma reinstalação do servidor perderia a página.

Para publicar uma alteração:

```bash
scp deploy/downloads/index.html root@46.202.151.252:/opt/alphafitus-downloads/index.html
```

O `.exe` do Alphafitus OS não está aqui (37 MB, produto de outro
repositório) — ele fica só no servidor, na mesma pasta.

## Senha da página de downloads

É uma senha separada do login do sistema, configurada no
`/etc/caddy/Caddyfile` como hash (`caddy hash-password`). Para trocar:

```bash
caddy hash-password --plaintext 'NOVA_SENHA'
# cole o hash no Caddyfile, em basic_auth, e recarregue:
systemctl reload caddy
```
