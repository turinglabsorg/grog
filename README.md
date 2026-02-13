# Grog

Grog is an autonomous GitHub issue solver. Point it at an issue, and it uses Claude to analyze code, implement fixes, and open pull requests — without human intervention.

## How It Works

```
  @grog-agent[bot] solve this
          |
          v
  GitHub Webhook ──> Agent (Express) ──> MongoDB ──> Claude ──> PR
```

1. Someone mentions the bot on a GitHub issue
2. The webhook hits the agent server
3. The agent clones the repo, spawns Claude, and works on the fix
4. When done, it pushes a branch and opens a pull request
5. If the agent needs clarification, it asks — and picks back up when you reply

## Architecture

```
grog/
  shared/   - Shared TypeScript library (types, state, GitHub API, auth, billing)
  agent/    - Self-hosted agent server (webhook, dashboard, runner, poll loop)
  api/      - SaaS API server (OAuth, billing, Stripe)
  app/      - SaaS frontend (React)
  skill/    - Claude Code CLI skills (/grog-solve, /grog-explore, /grog-review, /grog-answer)
  pm2/      - PM2 ecosystem config for production
```

## Deployment Modes

### 1. Self-Host (free)

Run the agent on your own machine. You bring your own Anthropic API key and Claude Code CLI. No billing, no limits — just `yarn dev:agent` and go.

### 2. SaaS with Credits

Hosted by Turing Labs. Pay-per-token via credit packs (Stripe). 10,000 tokens = 1 credit. Credits are automatically deducted after each job completes.

### 3. Dedicated (coming soon)

Dedicated VPS per customer with managed infrastructure.

## Self-Host Setup

### Prerequisites

- **Node.js** 20+
- **MongoDB** running locally or a connection string
- **Anthropic API key** (set as `ANTHROPIC_API_KEY` in your shell)
- **Claude Code CLI** installed (`npm install -g @anthropic-ai/claude-code`)

### Step 1: Create a GitHub App

1. Go to [github.com/settings/apps/new](https://github.com/settings/apps/new)
2. Fill in:
   - **GitHub App name**: pick a name (e.g. `my-grog-agent`)
   - **Homepage URL**: `http://localhost:3000`
   - **Webhook URL**: your public URL + `/webhook` (or leave blank if polling only)
   - **Webhook secret**: generate a random string and save it
3. Set **Permissions**:
   - Repository > **Contents**: Read and write
   - Repository > **Issues**: Read and write
   - Repository > **Pull requests**: Read and write
   - Repository > **Metadata**: Read-only
4. **Subscribe to events**:
   - Issue comment
   - Issues
   - Pull request
5. Click **Create GitHub App**
6. Note the **App ID** shown at the top of the page
7. Scroll down and click **Generate a private key** — save the `.pem` file

### Step 2: Install the App

1. Go to `https://github.com/settings/apps/<your-app-name>/installations`
2. Click **Install**
3. Select your organization or account
4. Choose **All repositories** or select specific repos
5. Click **Install**

### Step 3: Install and Build

```bash
git clone https://github.com/turinglabsorg/grog.git
cd grog
yarn install
yarn build
```

### Step 4: Configure

```bash
cp agent/.env.example agent/.env
```

Edit `agent/.env`:

```env
# MongoDB connection
MONGODB_URI=mongodb://localhost:27017/grog

# Server port
PORT=3000

# Max parallel jobs (default: 2)
MAX_CONCURRENT_JOBS=2

# Working directory for cloned repos
WORK_DIR=/tmp/grog-jobs

# Agent timeout in minutes (default: 30)
AGENT_TIMEOUT_MINUTES=30
```

You do **not** need `GH_TOKEN` or `WEBHOOK_SECRET` in the `.env` — these are configured through the dashboard.

### Step 5: Start the Agent

```bash
yarn dev:agent
```

### Step 6: Connect via Dashboard

1. Open [http://localhost:3000](http://localhost:3000)
2. You'll see the **Connect GitHub App** setup screen
3. Enter your **App ID** (from Step 1)
4. Paste the contents of your **private key** `.pem` file
5. Optionally enter your **webhook secret**
6. Click **Connect**

The dashboard will verify the connection and show the rate limit (should be 5,000/hr).

### Step 7: Use It

On any issue in a repo where the app is installed, comment:

```
@your-app-name[bot] solve this
```

The agent will pick it up, work on it, and open a PR.

## Follow-up Loop

When the agent can't solve an issue on the first pass, it posts a comment asking for clarification and sets the job to `waiting_for_reply`. When you reply and mention the bot again, the agent re-runs with the full conversation — the new reply is highlighted so Claude knows exactly what changed.

## Dashboard

The agent includes a built-in terminal-style dashboard at `http://localhost:3000`:

- **Job list** — all jobs with status, repo, issue, age, token usage
- **Live terminal** — click any job to see real-time Claude output (SSE streaming)
- **Stop/Start** — pause and resume jobs from the terminal panel
- **Budget display** — token usage tracking with hourly/daily limits in the header
- **App status** — shows connected GitHub App with disconnect option

## Production Deployment (PM2)

```bash
yarn build
pm2 start pm2/ecosystem.config.cjs
```

For webhooks to work in production, your agent needs a public URL. Set the webhook URL in your GitHub App settings to point to `https://your-domain.com/webhook`.

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `MONGODB_URI` | No | `mongodb://localhost:27017/grog` | MongoDB connection |
| `PORT` | No | `3000` | Server port |
| `MAX_CONCURRENT_JOBS` | No | `2` | Max parallel jobs |
| `WORK_DIR` | No | `/tmp/grog-jobs` | Temp directory for repos |
| `AGENT_TIMEOUT_MINUTES` | No | `30` | Max time per job |
| `MAX_RETRIES` | No | `2` | Retries for transient failures |
| `DAILY_TOKEN_BUDGET` | No | `0` (unlimited) | Daily token limit |
| `HOURLY_TOKEN_BUDGET` | No | `0` (unlimited) | Hourly token limit |
| `LOG_LEVEL` | No | `info` | `debug`, `info`, `warn`, `error` |
| `LOG_FORMAT` | No | human-readable | Set to `json` for structured output |
| `STRIPE_SECRET_KEY` | No | — | Enable billing (SaaS mode) |

The GitHub App credentials (App ID, private key, installation ID) are stored in MongoDB and configured through the dashboard — no need to put them in `.env`.

## CLI Skills

Install Claude Code skills for local issue solving:

```bash
cd skill && ./install.sh
```

Then in any Claude Code session:

```
/grog-solve https://github.com/owner/repo/issues/123
/grog-explore https://github.com/owner/repo
/grog-review https://github.com/owner/repo/pull/456
/grog-answer https://github.com/owner/repo/issues/123
```

## License

MIT
