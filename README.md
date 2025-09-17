# getcdnimages — Imagens públicas via CDN (API + CLI)

Objetivo
- Baixar/servir imagens que são públicas e abrem no navegador, mas falham em um GET “simples” porque o CDN exige headers típicos de browser (Referer, Accept, User‑Agent) ou cookies.
- A API aplica headers de navegador por padrão e permite enviar headers/cookies extras; também “fareja” o tipo quando o CDN devolve `text/plain` por engano.

Descrição
- API HTTP e ferramenta de linha de comando para baixar imagens quando você já tem acesso (tokens/URLs válidos quando aplicável).
- Suporta múltiplas URLs, arquivo de entrada, headers/cookies, concorrência e tentativas (CLI).
- Requer Node.js 18+ e não contorna proteções; uso legal/autorizado.

CLI — Instalação/Execução
- Local (sem instalar):
  - `node bin/cdn-dl.js --url https://cdn.exemplo.com/img.jpg --output imgs`
- Como binário global (opcional):
  - Dentro desta pasta, rode `npm i -g` para disponibilizar o comando `cdn-dl`.
  - Exemplo: `cdn-dl --input urls.txt --concurrency 6`.

Opções
- `--url <URL>`: adiciona uma URL (pode repetir)
- `--input <arquivo>`: TXT (uma URL por linha) ou JSON (array)
- `--output <dir>`: pasta de destino (default: `downloads`)
- `--concurrency <n>`: downloads em paralelo (default: 4)
- `--retry <n>`: tentativas por arquivo (default: 2)
- `--header "K: V"`: header extra (pode repetir)
- `--cookie "k=v"`: adiciona cookie (pode repetir)
- `--auth <token|Bearer ...>`: define `Authorization` (prefixa Bearer se faltar)
- `--referer <url>` e `--origin <url>`
- `-h, --help`: ajuda

Exemplos
- `cdn-dl --url https://cdn.example.com/assets/img/1.jpg --output imgs`
- `cdn-dl --input urls.txt --header "User-Agent: MyAgent/1.0"`
- `cdn-dl --url https://cdn.example.com/... --auth abc123 --referer https://seu-site`

Estrutura
- `package.json`: metadados NPM e binário `cdn-dl`.
- `bin/cdn-dl.js`: implementação do CLI (ESM, Node 18+).
- `server.js`: API HTTP para proxy de imagens.

API HTTP — Documentação
- Base URL (Swarm): `http://getcdnimages:3000` (nome do service) ou via published port `http://<manager>:8080`.
- Health: `GET /health` → `{ ok: true, service: "getcdnimages", ... }`

1) GET /image
- Baixa/streama a imagem de uma URL, mesmo que não tenha extensão `.jpg`.
- Parâmetros query:
  - `url` (obrigatório): URL da imagem (http/https)
  - `auth`: valor de Authorization (prefixa `Bearer ` se faltar)
  - `referer`, `origin`: cabeçalhos Referer/Origin
  - `header`: pode repetir, formato `K: V`
  - `cookie`: pode repetir, valor `k=v`
  - `contentDisposition`: `inline` (padrão) ou `attachment`
  - `filename`: nome sugerido (se for fazer download)
  - `timeout`: em ms (default 15000, máx 120000)
  - `allowAny`: `1` para permitir content-type não `image/*`
- Respostas:
  - 200: corpo é a imagem; `content-type` e `content-disposition` propagados
  - 400/415/502: JSON de erro `{ ok:false, error, ... }`

Exemplo (URL sem extensão):
`GET /image?url=https%3A%2F%2Fcdn.example.com%2Fpath%2Fto%2Fresource%3Fv%3D12345`

2) POST /image
- Mesma função, mas via JSON: `{ url, headers, auth, referer, origin, cookie, contentDisposition, filename, timeout, allowAny }`
- Útil para n8n quando quiser mandar cabeçalhos como objeto.

n8n — Configuração rápida
- Node HTTP Request:
  - Método: GET
  - URL: `http://getcdnimages:3000/image`
  - Query Parameters: `url=<SUA_URL>`, opcionalmente `auth`, `referer`, `origin`, `header`, `cookie`
  - Response Format: Binary
  - Binary Property: `data`

Ou usando POST:
- Método: POST
- URL: `http://getcdnimages:3000/image`
- Body: JSON `{ "url": "<SUA_URL>", "auth": "Bearer xxx", "referer": "..." }`
- Response Format: Binary
- Binary Property: `data`

Docker
- Build da imagem: dentro de `getcdnimages/`
  - `docker build -t getcdnimages:latest .`
  - Teste local: `docker run --rm -p 8080:3000 getcdnimages:latest`
  - Teste: `curl "http://localhost:8080/image?url=..." -o out.jpg`

Logs
- Cada requisição gera logs em JSON com: início (`event=start`), resposta upstream (`event=upstream`), e finalização (`event=done` com bytes e ms). Visualize via `docker logs` ou `docker service logs`.

Docker Swarm (stack)
- Arquivo: `getcdnimages/docker-stack.yml`
- Ajuste `image: ghcr.io/elefantemarketing/getcdnimages:latest` (ou seu registry)
- Suba imagem para seu registry, depois:
  - `docker stack deploy -c docker-stack.yml getcdn`
- Acesso interno (overlay): `http://getcdnimages:3000/image?url=...`
- Acesso publicado: `http://<manager>:8080/image?url=...`

Versionamento
- Releases no GitHub seguem tags `vMAJOR.MINOR` (ex.: `v1.0`, `v1.1`).
- Imagens no GHCR são publicadas com `vX.Y`, `X.Y` e `latest`.
- Produção pode fixar `image: ghcr.io/<owner>/getcdnimages:1.0` para estabilidade, mantendo `latest` para testes.

Observação
- Este diretório já está pronto para ser usado como repositório dedicado. Você pode inicializar um git aqui com `git init`, criar um README adicional e versionar conforme necessário.
