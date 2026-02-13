# Grog

> *"Arr matey, point me at the issue and I'll have a PR ready before the rum runs out!"*

Grog is an autonomous GitHub issue solver. It watches your repos via webhooks, picks up issues, and uses Claude to analyze code, implement fixes, and open pull requests — all without human intervention.

## Architecture

```
GitHub Webhook  ──►  web/ (Express)  ──►  MongoDB  ──►  agent/ workers  ──►  PRs
```

| Component | What it does |
|---|---|
| **`skill/`** | Claude Code CLI skills — `/grog-solve`, `/grog-explore`, `/grog-review` |
| **`shared/`** | Shared TypeScript library — types, config, state, GitHub API, budget |
| **`web/`** | Express server — dashboard, REST API, webhook receiver, OAuth |
| **`agent/`** | Worker process — polls MongoDB, runs Claude agents, pushes PRs |

The web server receives GitHub webhooks and writes jobs to MongoDB. Agent workers poll MongoDB and atomically claim jobs via `findOneAndUpdate`. Multiple workers can run in parallel.

## Self-host Quickstart

```bash
# Install all workspaces
npm install

# Build everything
npm run build

# Start web server + agent worker (needs MongoDB running)
npm run dev:web &
npm run dev:agent
```

Both `web/` and `agent/` need the same `.env` — copy from the examples:

```bash
cp web/.env.example web/.env
cp agent/.env.example agent/.env
# Edit both with your GH_TOKEN, WEBHOOK_SECRET, MONGODB_URI
```

Dashboard available at `http://localhost:3000/dashboard`.

## CLI Skills

Install the Claude Code skills for local issue solving:

```bash
cd skill && ./install.sh
```

Then in any Claude Code session:

```bash
/grog-solve https://github.com/owner/repo/issues/123
/grog-explore https://github.com/owner/repo
/grog-review https://github.com/owner/repo/pull/456
```

## Production Deployment (PM2)

```bash
npm run build
pm2 start ecosystem.config.cjs
```

This starts one web server instance and two agent workers.

## Environment Variables

### Web Server (`web/.env`)

| Variable | Required | Default | Description |
|---|---|---|---|
| `GH_TOKEN` | Yes | — | GitHub token with `repo` scope |
| `WEBHOOK_SECRET` | Yes | — | Global webhook secret |
| `BOT_USERNAME` | No | `grog` | GitHub bot username |
| `PORT` | No | `3000` | Server port |
| `MONGODB_URI` | No | `mongodb://localhost:27017/grog` | MongoDB connection |
| `DAILY_TOKEN_BUDGET` | No | `0` (unlimited) | Daily token limit |
| `HOURLY_TOKEN_BUDGET` | No | `0` (unlimited) | Hourly token limit |
| `GITHUB_CLIENT_ID` | No | — | OAuth app ID (enables login/setup) |
| `GITHUB_CLIENT_SECRET` | No | — | OAuth app secret |
| `SESSION_SECRET` | No | — | Cookie signing secret |
| `BASE_URL` | No | `http://localhost:3000` | Public URL for OAuth callbacks |

### Agent Worker (`agent/.env`)

| Variable | Required | Default | Description |
|---|---|---|---|
| `GH_TOKEN` | Yes | — | GitHub token with `repo` scope |
| `WEBHOOK_SECRET` | Yes | — | Global webhook secret |
| `BOT_USERNAME` | No | `grog` | GitHub bot username |
| `MAX_CONCURRENT_JOBS` | No | `2` | Max parallel jobs per worker |
| `WORK_DIR` | No | `/tmp/grog-jobs` | Temp directory for cloned repos |
| `MONGODB_URI` | No | `mongodb://localhost:27017/grog` | MongoDB connection |
| `AGENT_TIMEOUT_MINUTES` | No | `30` | Max time per job |
| `MAX_RETRIES` | No | `2` | Retry count for transient failures |

## Dashboard

The Kanban-style dashboard shows all jobs across columns: New, Worked, Waiting, Completed, Failed, Closed. Features:

- Drag-and-drop cards between columns
- Click cards to see live agent logs (SSE streaming)
- Stop running workers from the log panel
- Repo configuration management
- Admin stats and bulk operations
- GitHub OAuth login + one-click repo setup (when OAuth configured)

Without OAuth configured, the dashboard works in read-only self-host mode — the Setup tab is hidden but everything else works.

## License

ISC

---

*Made with mass amounts of mass amounts of mass amounts of rum*
