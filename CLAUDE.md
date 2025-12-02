# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Development Commands

```bash
bun install          # Install dependencies
bun run build        # Build 11ty static site into _site/
bun run dev          # Start server with watch mode (auto-restarts on changes)
bun run start        # Start server without watching
```

### Docker Development

```bash
./dev                # Start dev server with Docker (builds site + watches for changes)
./dev -d             # Start in detached mode (background)
./dev down           # Stop containers
./dev restart        # Restart containers
./dev rebuild        # Rebuild container from scratch
./dev logs -f        # Follow container logs
./dev shell          # Open shell in container
./dev status         # Show container status and resource usage
./dev clean          # Remove containers, volumes, and images
./dev --help         # Show all available commands
```

The server runs on port 8147 by default (configurable via PORT env var).

## Architecture

WebhookSpy is a webhook testing tool with two main components:

### Backend (`src/server.ts`)
A Bun HTTP server that handles:
- **Webhook capture**: Any request to `/{32-char-hex-id}` is captured and stored
- **SSE streaming**: Real-time updates via `/api/endpoints/{id}/stream`
- **REST API**: `POST /api/endpoints` (create), `GET /api/endpoints/{id}` (metadata)
- **Static serving**: Serves 11ty-built files from `_site/`

SQLite database (`data/webhookspy.sqlite`) stores endpoints and requests. Key constraints:
- Endpoints expire after 7 days of inactivity (auto-recreated on next request)
- Max 100 requests per endpoint (oldest pruned automatically)
- Request bodies truncated at 512KB

### Frontend (`src/site/`)
11ty (Eleventy) static site with Nunjucks templates:
- `_includes/layout.njk` - Base layout with Tailwind config and Alpine.js theme switcher
- `index.njk` - Homepage with endpoint creation
- `endpoint.njk` - Inspector page with SSE-powered live request viewer

Frontend uses Alpine.js for reactivity and Tailwind CSS (via CDN) for styling.

## API Routes

| Route | Method | Description |
|-------|--------|-------------|
| `/{id}` | ANY | Capture webhook request |
| `/inspect/{id}` | GET | Serve inspector page |
| `/api/endpoints` | POST | Create new endpoint |
| `/api/endpoints/{id}` | GET | Get endpoint metadata + requests |
| `/api/endpoints/{id}/stream` | GET | SSE stream for live updates |

## Key Implementation Details

- Endpoint IDs are 32-character lowercase hex strings (UUID without dashes)
- SSE subscribers stored in memory Map; broadcast on new request capture
- Expired endpoint cleanup runs on each request (throttled to once per minute)
- Request IP captured via `server.requestIP(req)`
