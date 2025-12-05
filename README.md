# WebhookSpy

<p align="center">
  <img src="webhookspy-logo.png" alt="WebhookSpy logo" width="320" />
</p>

WebhookSpy is a lightweight webhook inspector powered by Bun, Elysia, SQLite, Alpine.js, Tailwind CSS, and 11ty. It gives you permanent HTTP endpoints that you can use forever for testing, stream payloads over Server-Sent Events (SSE), and present the captures in a modern, polished UI.

## Features

- **One-click endpoints** – Generate unique webhook URLs and matching inspector links directly from the homepage.
- **Permanent URLs** – Your webhook URL never expires. Data clears after 7 days of inactivity, but the same URL keeps working automatically.
- **Live streaming inspector** – Requests appear instantly via SSE with a sidebar list and detailed headers/body view.
- **REST API with OpenAPI docs** – Full programmatic access via REST API with interactive documentation at `/docs`.
- **Request filtering API** – Query captured requests by method, path, body content, or headers for easy test assertions.
- **Smart retention** – Keeps the last 100 requests per endpoint. Older requests are automatically pruned.
- **Theme aware UI** – Supports automatic light/dark detection plus a manual theme switcher.
- **Secure endpoints** – Optionally protect endpoints with access keys for testing sensitive webhooks.
- **Security hardened** – Rate limiting, security headers (CSP, X-Frame-Options), and XSS protection built-in.

## Architecture Overview

```
┌────────────┐    captures/streams     ┌───────────────────────────┐
│ HTTP client│ ──────────────────────▶ │ Elysia server (server.ts) │
└────────────┘                         │  • REST + webhook catcher │
                                       │  • OpenAPI docs at /docs  │
                                       │  • SQLite persistence     │
                                       └────────────┬──────────────┘
                                                    │ serves
                                                    ▼
                                       ┌───────────────────────────┐
                                       │ 11ty site (src/site)      │
                                       │  • Tailwind + Alpine UI   │
                                       │  • Live inspector (#SSE)  │
                                       └───────────────────────────┘
```

The Elysia server (running on Bun) exposes `/api` endpoints with auto-generated OpenAPI documentation at `/docs`, captures any HTTP request to `/{endpointId}`, and uses SQLite for storage and retention rules. The frontend is generated with 11ty/Nunjucks templates and Alpine.js for interactivity, compiled into `_site/` and served by the same process.

## Prerequisites

**Option A: Docker (recommended)**

- [Docker](https://docs.docker.com/get-docker/) with Docker Compose

**Option B: Local Bun installation**

- [Bun](https://bun.sh/) 1.1+ (includes `bun install`, `bun run`, and bun-provided TypeScript runtime).
- macOS/Linux with SQLite available (Bun bundles SQLite so nothing extra is required).

## Getting started

### Using Docker (recommended)

```bash
# clone the repo, then
git clone https://github.com/djedi/WebHookSpy.git
cd WebhookSpy

# start the development server
./dev
```

That's it! The script builds the site and starts the server with hot reload.

### Using Bun directly

```bash
# clone the repo, then
git clone https://github.com/djedi/WebHookSpy.git
cd WebhookSpy

# install dependencies
bun install

# build the static site (11ty output lives in _site/)
bun run build

# start the dev server
bun run dev
```

The first build generates `_site/index.html` and `_site/endpoint/index.html`, which the Bun server serves along with the API endpoints.

## Local development

Once the server starts, visit `http://localhost:8147` to generate endpoints. The workflow:

1. Click **Quick Endpoint** for public testing or **Secure Endpoint** for access-key protected inspection.
2. Point any HTTP client/webhook provider at the webhook URL (`/{id}`).
3. Open the inspector URL (`/inspect/{id}`) in a browser to watch requests stream in live.

For secure endpoints, copy and save the access key shown after creation—it's only displayed once. Share the key with teammates via URL (`/inspect/{id}?key=whspy_...`) or they can enter it manually.

### Querying captured requests

Use the `/api/endpoints/{id}/requests` endpoint to programmatically retrieve and filter captured requests—useful for test assertions and CI/CD pipelines.

```bash
# Get all captured requests
curl "http://localhost:8147/api/endpoints/{id}/requests"

# Filter by HTTP method
curl "http://localhost:8147/api/endpoints/{id}/requests?method=POST"

# Filter by body text (substring match)
curl "http://localhost:8147/api/endpoints/{id}/requests?body=order_id"

# Filter by JSON body key existence
curl "http://localhost:8147/api/endpoints/{id}/requests?body_key=user_id"

# Filter by JSON body key:value
curl "http://localhost:8147/api/endpoints/{id}/requests?body_value=status:completed"

# Filter by header existence
curl "http://localhost:8147/api/endpoints/{id}/requests?header_key=x-signature"

# Filter by header name:value
curl "http://localhost:8147/api/endpoints/{id}/requests?header_value=content-type:application/json"

# Filter by query param existence
curl "http://localhost:8147/api/endpoints/{id}/requests?query_key=rand"

# Filter by query param key:value
curl "http://localhost:8147/api/endpoints/{id}/requests?query_value=rand:24052"

# Combine filters and limit results
curl "http://localhost:8147/api/endpoints/{id}/requests?method=POST&body_key=event&limit=1"
```

| Parameter      | Description                                           |
| -------------- | ----------------------------------------------------- |
| `method`       | Filter by HTTP method (GET, POST, etc.)               |
| `path`         | Filter by request path (substring match)              |
| `body`         | Filter by body text (substring match)                 |
| `body_key`     | Filter by JSON body key existence                     |
| `body_value`   | Filter by JSON body key:value (format: `key:value`)   |
| `query_key`    | Filter by query param key existence                   |
| `query_value`  | Filter by query param key:value (format: `key:value`) |
| `header_key`   | Filter by header existence (case-insensitive)         |
| `header_value` | Filter by header name:value (format: `name:value`)    |
| `limit`        | Limit number of results returned                      |

### Running in production mode

```bash
# ensure the site is built first
bun run build

# start without file watching
bun run start
```

## Production Deployment

### Quick Start with Docker

Pull and run the pre-built image from Docker Hub:

```bash
docker run -d \
  --name webhookspy \
  -p 8147:8147 \
  -v webhookspy-data:/app/data \
  --restart unless-stopped \
  xhenxhe/webhookspy:latest
```

Then visit `http://localhost:8147` (or your server's IP/domain).

### Docker Compose (Recommended)

Create a `docker-compose.yml` file:

```yaml
services:
  webhookspy:
    image: xhenxhe/webhookspy:latest
    container_name: webhookspy
    ports:
      - '8147:8147'
    volumes:
      - webhookspy-data:/app/data
    restart: unless-stopped
    healthcheck:
      test: ['CMD', 'curl', '-f', 'http://localhost:8147/']
      interval: 30s
      timeout: 3s
      retries: 3

volumes:
  webhookspy-data:
```

Then run:

```bash
docker compose up -d
```

### With Reverse Proxy (Caddy example)

```yaml
services:
  webhookspy:
    image: xhenxhe/webhookspy:latest
    container_name: webhookspy
    volumes:
      - webhookspy-data:/app/data
    restart: unless-stopped
    networks:
      - caddy

  caddy:
    image: caddy:latest
    container_name: caddy
    ports:
      - '80:80'
      - '443:443'
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile
      - caddy-data:/data
      - caddy-config:/config
    restart: unless-stopped
    networks:
      - caddy

networks:
  caddy:

volumes:
  webhookspy-data:
  caddy-data:
  caddy-config:
```

Create a `Caddyfile`:

```
webhooks.yourdomain.com {
    reverse_proxy webhookspy:8147
}
```

### Portainer Deployment

1. Go to **Stacks** → **Add stack**
2. Name it `webhookspy`
3. Paste this in the Web editor:

```yaml
version: '3.8'

services:
  webhookspy:
    image: xhenxhe/webhookspy:latest
    container_name: webhookspy
    ports:
      - '8147:8147'
    volumes:
      - webhookspy-data:/app/data
    restart: unless-stopped

volumes:
  webhookspy-data:
```

4. Click **Deploy the stack**

### Environment Variables

| Variable | Default | Description                |
| -------- | ------- | -------------------------- |
| `PORT`   | `8147`  | Port the server listens on |

### Build Your Own Image

```bash
# Clone the repo
git clone https://github.com/djedi/WebHookSpy.git
cd WebhookSpy

# Build locally
./build

# Build and push to Docker Hub
./build push -t v1.0.0

# Multi-platform build (amd64 + arm64)
./build multi -t v1.0.0
```

## Security

### Secure Endpoints

For testing webhooks with sensitive data, create a **Secure Endpoint**:

- Access keys are generated server-side with a `whspy_` prefix
- Keys are hashed (bcrypt) before storage—we never store plaintext keys
- The inspector and SSE stream require the access key to view requests
- Webhook capture still works without the key (requests are recorded, just not viewable without auth)

> **Important**: Secure endpoints follow the same 7-day inactivity expiration as regular endpoints. If your endpoint expires, **your access key becomes invalid**—the endpoint will be auto-recreated as a new, unprotected endpoint if someone hits the URL again. To keep a secure endpoint alive, ensure it receives activity (webhook requests, inspector visits, or API calls) at least once every 7 days.

### Rate Limiting

To prevent abuse, WebhookSpy enforces per-IP rate limits:

| Action            | Limit          |
| ----------------- | -------------- |
| Endpoint creation | 10 per minute  |
| Webhook requests  | 100 per minute |

Exceeding limits returns HTTP 429 with a `Retry-After` header.

### Security Headers

All responses include security headers:

- `Content-Security-Policy` – Restricts script/style sources
- `X-Frame-Options: DENY` – Prevents clickjacking
- `X-Content-Type-Options: nosniff` – Prevents MIME sniffing
- `X-XSS-Protection: 1; mode=block` – Legacy XSS protection
- `Referrer-Policy: strict-origin-when-cross-origin`

### Best Practices

- Use **Secure Endpoints** when testing webhooks with API keys, tokens, or PII
- Public endpoints display a warning banner reminding users not to send sensitive data
- All JSON payloads are HTML-escaped before rendering to prevent XSS

## Data & storage

- Data files live under `data/webhookspy.sqlite`. The server creates the directory and database automatically.
- **Activity-based expiration**: Endpoints stay alive as long as they receive requests. The expiration timer resets to 7 days on each new request.
- **Request limit**: Each endpoint keeps up to 100 requests. Older requests are automatically deleted when the limit is exceeded.
- **Auto-recreation**: If an endpoint expires and you hit the same URL again, it's automatically recreated—so your URLs effectively work forever.
- To reset the local DB, stop the server and delete the `data` directory.

## Project structure

```
src/
  server.ts        # Bun server (API endpoints, SSE, static file serving)
  site/            # 11ty templates, layout, assets, Alpine components
    assets/        # static assets copied to /assets in the build output
_site/             # generated static files (build artifact)
data/              # SQLite database (created on demand)
```

## Useful scripts

### Docker dev script

| Command         | Description                                  |
| --------------- | -------------------------------------------- |
| `./dev`         | Start the dev server (builds site + watches) |
| `./dev -d`      | Start in detached mode (background)          |
| `./dev down`    | Stop and remove containers                   |
| `./dev restart` | Restart the containers                       |
| `./dev rebuild` | Rebuild container from scratch and start     |
| `./dev logs`    | Show container logs                          |
| `./dev logs -f` | Follow container logs                        |
| `./dev shell`   | Open a shell inside the container            |
| `./dev status`  | Show container status and resource usage     |
| `./dev clean`   | Remove containers, volumes, and images       |
| `./dev --help`  | Show all available commands                  |

### Build script

| Command                     | Description                                   |
| --------------------------- | --------------------------------------------- |
| `./build`                   | Build Docker image locally                    |
| `./build push`              | Build and push to Docker Hub                  |
| `./build push -t v1.0.0`    | Build and push with specific tag              |
| `./build release -t v1.0.0` | Tag as version + latest, then push            |
| `./build multi -t v1.0.0`   | Multi-platform build (amd64 + arm64) and push |
| `./build --no-cache`        | Build without cache                           |
| `./build --dry-run`         | Show commands without executing               |

### Bun scripts

| Script          | Description                              |
| --------------- | ---------------------------------------- |
| `bun run dev`   | Start the Bun server with watch mode.    |
| `bun run start` | Start the Bun server once (no watching). |
| `bun run build` | Build the 11ty site into `_site/`.       |

## Contributing

Contributions are welcome whether it's bug reports, docs, or new features.

1. Fork the repository and create a feature branch (`git checkout -b feature/my-idea`).
2. Run `bun install` once, then use `bun run dev` or `./dev` for a live server while you work.
3. Execute `./test` to run the Bun test suite (add `--watch`, `--changed`, or `--report` for coverage reports) and keep it green.
4. Please run `bun run build` before opening a PR to ensure the 11ty site still builds.
5. Open a pull request that describes the change, how to test it, and links to any related issues.

Not sure where to start? Check the [issue tracker](https://github.com/djedi/WebHookSpy/issues) for `good first issue` or `help wanted` labels, or open a discussion with your proposal.

## Community & Support

- **Questions / ideas**: [GitHub Discussions](https://github.com/djedi/WebHookSpy/discussions) or start a new issue.
- **Bug reports**: include Bun version, OS, reproduction steps, and relevant logs/SSE output in a [GitHub issue](https://github.com/djedi/WebHookSpy/issues).
- **Security concerns**: please email the maintainer or open a private security advisory instead of a public issue.

## Troubleshooting

- **Inspector page shows “Inspector unavailable”**: Run `bun run build` so `_site/endpoint/index.html` exists.
- **No requests appear**: Make sure you are hitting the webhook URL (e.g., `http://localhost:8147/abcdef123...`) and that the inspector tab stays open to keep the SSE connection alive.
- **Theme switch stuck**: The theme toggle stores its choice in `localStorage` under `webhookspy-theme`. Clear it if you need to reset to system defaults.

## License

WebhookSpy is released under the [MIT License](LICENSE). Feel free to fork, deploy, and build on it in your own stack.

Happy debugging!
