# WebhookSpy

WebhookSpy is a lightweight webhook inspector powered by Bun, SQLite, Alpine.js, Tailwind CSS, and 11ty. It gives you permanent HTTP endpoints that you can use forever for testing, stream payloads over Server-Sent Events (SSE), and present the captures in a modern, polished UI.

## Features

- **One-click endpoints** – Generate unique webhook URLs and matching inspector links directly from the homepage.
- **Permanent URLs** – Your webhook URL never expires. Data clears after 7 days of inactivity, but the same URL keeps working automatically.
- **Live streaming inspector** – Requests appear instantly via SSE with a sidebar list and detailed headers/body view.
- **Smart retention** – Keeps the last 100 requests per endpoint. Older requests are automatically pruned.
- **Theme aware UI** – Supports automatic light/dark detection plus a manual theme switcher.

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
cd WebhookSpy

# start the development server
./dev
```

That's it! The script builds the site and starts the server with hot reload.

### Using Bun directly

```bash
# clone the repo, then
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

1. Click **New endpoint** → the UI shows both the webhook URL (`/{id}`) and inspector URL (`/inspect/{id}`).
2. Point any HTTP client/webhook provider at the webhook URL.
3. Open the inspector URL in a browser to watch requests stream in live. Hitting the raw webhook URL in a browser counts as a GET capture.

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
      - "8147:8147"
    volumes:
      - webhookspy-data:/app/data
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:8147/"]
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
      - "80:80"
      - "443:443"
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
version: "3.8"

services:
  webhookspy:
    image: xhenxhe/webhookspy:latest
    container_name: webhookspy
    ports:
      - "8147:8147"
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
git clone https://github.com/yourusername/WebhookSpy.git
cd WebhookSpy

# Build locally
./build

# Build and push to Docker Hub
./build push -t v1.0.0

# Multi-platform build (amd64 + arm64)
./build multi -t v1.0.0
```

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

## Troubleshooting

- **Inspector page shows “Inspector unavailable”**: Run `bun run build` so `_site/endpoint/index.html` exists.
- **No requests appear**: Make sure you are hitting the webhook URL (e.g., `http://localhost:8147/abcdef123...`) and that the inspector tab stays open to keep the SSE connection alive.
- **Theme switch stuck**: The theme toggle stores its choice in `localStorage` under `webhookspy-theme`. Clear it if you need to reset to system defaults.

Happy debugging!
