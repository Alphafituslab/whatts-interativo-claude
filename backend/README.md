# Whatts Inbox

Caixa de entrada de WhatsApp compartilhada: vários usuários fazem login (cada um com sua conta) e todos veem/respondem através de **um único número de WhatsApp** conectado ao sistema. Projeto independente — não depende do Alphafitus OS.

Backend: Python/Flask + SQLite. Frontend: JavaScript puro (sem build step). Conexão com o WhatsApp via [Evolution API](https://github.com/EvolutionAPI/evolution-api) (open-source, auto-hospedada, **não é a API oficial da Meta** — ver aviso abaixo).

## Por que não a API oficial da Meta

A API oficial (WhatsApp Cloud API) cobra por conversa e exige aprovação de conta de negócio. A Evolution API é gratuita (só custa a hospedagem, geralmente um contêiner Docker local) e conecta via QR Code, como o WhatsApp Web. **Isso não é um uso oficial/aprovado pelo WhatsApp** — o número pode ser banido em caso de uso abusivo (disparo em massa, robô sem resposta humana). Use apenas para atendimento humano normal, um a um.

## Como rodar

```bash
cd backend
python -m venv venv
venv\Scripts\pip install -r requirements.txt          # Windows
# source venv/bin/activate && pip install -r requirements.txt   # Linux/Mac

set WPP_JWT_SECRET=uma-chave-bem-grande-e-aleatoria     # Windows (cmd)
$env:WPP_JWT_SECRET="uma-chave-bem-grande-e-aleatoria"   # Windows (PowerShell)

python seed.py      # cria o primeiro usuário administrador (senha impressa no terminal)
python run.py        # sobe em http://127.0.0.1:5050
```

Em produção, use `waitress` em vez do servidor de desenvolvimento do Flask:
```bash
venv\Scripts\waitress-serve --host=127.0.0.1 --port=5050 run:app
```

## Instalar a Evolution API (Docker)

Pré-requisito: Docker Desktop instalado e rodando (no Windows, precisa do
WSL2 habilitado — `wsl --install` num PowerShell como administrador, se
ainda não tiver).

**Atenção:** o projeto mudou de organização no Docker Hub — a imagem
correta hoje é `evoapicloud/evolution-api` (não mais `atendai/...`). A
versão 2.x também passou a **exigir um banco Postgres de verdade**
(`DATABASE_ENABLED=false` não é mais suportado) — por isso usamos Docker
Compose com Postgres junto, em vez de um único `docker run`.

Crie um arquivo `docker-compose.yml` (veja `evolution-api/docker-compose.yml`
neste projeto, já pronto) com o seguinte conteúdo e rode `docker compose up -d`
na pasta dele:

```yaml
services:
  postgres:
    image: postgres:15
    container_name: evolution-postgres
    restart: always
    environment:
      POSTGRES_USER: evolution
      POSTGRES_PASSWORD: escolha-uma-senha-forte
      POSTGRES_DB: evolution
    volumes:
      - evolution_postgres_data:/var/lib/postgresql/data

  evolution-api:
    image: evoapicloud/evolution-api:v2.3.4
    container_name: evolution-api
    restart: always
    depends_on:
      - postgres
    ports:
      - "8080:8080"
    environment:
      AUTHENTICATION_API_KEY: escolha-uma-chave-forte
      DATABASE_ENABLED: "true"
      DATABASE_PROVIDER: postgresql
      DATABASE_CONNECTION_URI: postgresql://evolution:escolha-uma-senha-forte@postgres:5432/evolution?schema=public
      DATABASE_SAVE_DATA_INSTANCE: "true"
      DATABASE_SAVE_DATA_NEW_MESSAGE: "true"
      DATABASE_SAVE_MESSAGE_UPDATE: "true"
      DATABASE_SAVE_DATA_CONTACTS: "true"
      DATABASE_SAVE_DATA_CHATS: "true"
      CACHE_REDIS_ENABLED: "false"
      CACHE_LOCAL_ENABLED: "true"

volumes:
  evolution_postgres_data:
```

A primeira subida demora um pouco (baixa as imagens + roda as migrations
do banco) — acompanhe com `docker compose logs -f evolution-api` até ver
`HTTP - ON: 8080`. Depois disso, `http://localhost:8080` já responde
`"Welcome to the Evolution API, it is working!"`.

## Conectar o número da empresa

1. Faça login como administrador → **Configuração**.
2. Preencha a URL (`http://localhost:8080`) e a Chave de API (a mesma do `AUTHENTICATION_API_KEY` acima), marque **Ativo** e salve.
3. Copie a **URL de webhook** mostrada e cole na configuração de webhook da instância na Evolution API, para os eventos `MESSAGES_UPSERT`, `CONNECTION_UPDATE` e `QRCODE_UPDATED`.
4. Clique em **Conectar** — escaneie o QR Code com o WhatsApp do celular da empresa (Aparelhos conectados → Conectar um aparelho).
5. Em poucos segundos o status muda para "Conectado" sozinho.

## Gerenciar usuários

Um administrador cria novos logins em **Usuários** → **+ Novo usuário**. Qualquer usuário ativo vê e responde qualquer conversa (caixa de entrada compartilhada); só administradores acessam **Configuração** e **Usuários**.

## Variáveis de ambiente

| Variável | Obrigatória | Descrição |
|---|---|---|
| `WPP_JWT_SECRET` | sim | Chave secreta para assinar os tokens de sessão. |
| `WPP_DB_PATH` | não | Caminho do banco SQLite (padrão: `backend/data/whatsapp.db`). |
| `WPP_ADMIN_EMAIL` | não | Email do admin inicial ao rodar `seed.py` (padrão: `admin@whatts.local`). |
| `WPP_ADMIN_SENHA` | não | Senha do admin inicial (se não definida, uma senha forte é gerada e impressa uma única vez). |

## O que falta (próximos passos)

- Envio/recebimento de mídia (hoje só texto).
- Confirmação de entrega/leitura da mensagem enviada.
- Teste ponta-a-ponta contra uma instância real da Evolution API (só testado com webhook simulado até aqui).
- Possível integração/homologação futura com o Alphafitus OS (ainda não decidida).
