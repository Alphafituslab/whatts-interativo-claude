# Coisas que ficam fora do app Flask

## `downloads/index.html`

Página central de downloads da Alphafitus (Alphafitus OS + Seja Alpha +
ferramenta de banco). Não é servida pelo Flask: o Caddy entrega ela direto
do disco, de `/opt/alphafitus-downloads`, e exige senha (basic auth).

Fica versionada aqui porque mora numa pasta fora do repositório no
servidor — sem isso, uma reinstalação do servidor perderia a página.

Para publicar uma alteração:

```bash
scp deploy/downloads/index.html root@46.202.151.252:/opt/alphafitus-downloads/index.html
```

Os binários grandes não estão aqui — ficam só no servidor, na mesma
pasta: `AlphafitusOS_Servidor_Instalar.exe` (37 MB, produto de outro
repositório) e `DBBrowserForSQLite-instalador.msi` (20 MB, programa de
terceiro, baixado do sqlitebrowser.org).

## Senha da página de downloads

É uma senha separada do login do sistema, configurada no
`/etc/caddy/Caddyfile` como hash (`caddy hash-password`), usuário
`admin`. Protege `/downloads/*` **e** `/instalador/*` — o ZIP do
instalador é gerado pelo Flask fora de `/downloads`, e sem a segunda
trava ele seria a porta dos fundos da página protegida. As duas usam o
mesmo hash: ao trocar a senha, troque nos dois lugares. Para trocar:

```bash
caddy hash-password --plaintext 'NOVA_SENHA'
# cole o hash no Caddyfile, em basic_auth, e recarregue:
systemctl reload caddy
```
