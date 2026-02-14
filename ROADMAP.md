# Grog Roadmap

## Phase 1 — Webhook Agent

- [x] Express server with GitHub webhook receiver
- [x] HMAC signature verification
- [x] Agent spawner via `claude -p` CLI
- [x] Async clarification loop via GitHub comments
- [x] Job queue with concurrency control
- [x] MongoDB-backed state persistence
- [x] Trello-style job dashboard (`/dashboard`)
- [x] PR merge detection (auto-complete jobs)
- [x] Interactive kanban: drag-and-drop cards between columns
- [x] Closed column with GitHub side-effects (closes issue on GitHub)
- [x] Auto-accept repository invitations (on startup + every 60s)
- [x] Startup reconciliation: sync job state with GitHub on restart
- [x] Persistent logs in MongoDB (`job_logs` collection)
- [x] Live log streaming via SSE (cross-process via MongoDB polling)
- [x] Real-time token usage tracking (input/output) on cards and log panel
- [x] Token consumption reported in PR comments
- [x] PR creation via GitHub REST API (avoids `gh` CLI GraphQL rate limits)
- [x] Stop worker button in log panel (with confirmation)
- [x] CLI tool for manual job runs (`npx tsx cli/run-job.ts`)
- [x] Skips closed issues in CLI mode
- [x] Dashboard chat: send messages to running agents via interactive stdin (`--input-format stream-json`)
- [x] Chat interrupt: SIGINT pauses current turn, agent restarts with chat context
- [x] Create jobs from dashboard: `+` button to point at a GitHub issue URL or repo URL
- [x] Auto-create issues: if a repo URL is provided, Grog creates a GitHub issue first

## Phase 2 — Hardening

- [x] Error recovery and retry logic (retryable error classification, auto re-enqueue)
- [x] Timeout handling for long-running agents (configurable `AGENT_TIMEOUT_MINUTES`, SIGTERM/SIGKILL)
- [x] Logging (structured JSON logs via `LOG_FORMAT=json`, per-component logger)
- [x] PM2 ecosystem config for VPS deployment (`ecosystem.config.cjs`)
- [x] Rate limiting to respect Claude subscription limits (daily/hourly token budgets, dashboard indicator)
- [x] GitHub API rate limit handling (exponential backoff with jitter, `Retry-After` / `x-ratelimit-reset` support)

## Phase 3 — Multi-repo & Org-wide

- [x] Org-level webhook support (handles `issues` event for auto-solve on new issues)
- [x] Per-repo configuration (enabled, autoSolve, include/exclude labels, allowedUsers)
- [x] Admin API (bulk status updates, stats, purge old jobs)
- [x] Repo config CRUD API (`PUT/GET/DELETE /repos/:owner/:repo`)

## Phase 4 — Architecture & Self-service

- [x] GitHub OAuth login (cookie-based sessions, signed HMAC tokens)
- [x] Self-service repo setup via dashboard (invite bot + create webhook with unique per-repo secret)
- [x] Multi-webhook-secret support (per-repo secrets for ownership identification, fallback to global secret)
- [x] Dashboard: repo config management UI (add/edit repos, toggle autoSolve)
- [x] Dashboard: admin stats panel (total tokens, jobs by repo)
- [x] Dashboard: Setup tab with GitHub repo listing + one-click connect/disconnect
- [x] Monorepo restructure: `skill/` + `shared/` + `web/` + `agent/`
- [x] Separate web server (dashboard, API, webhook receiver) from agent worker
- [x] MongoDB-backed job queue (agent polls and atomically claims jobs)
- [x] Multiple agent workers can run in parallel

## Phase 5 — SaaS Platform (future)

Grog as a hosted service with tiered pricing:

**Tiers:**
- **Free (self-host):** User runs `web/` + `agent/` on their own machine, brings their own Claude subscription
- **Shared (pay-per-use):** User registers via OAuth on hosted platform, pays per token consumed
- **Dedicated (premium):** We spin up a dedicated VPS with a private agent worker

**Infrastructure:**
- [ ] Orchestrator webhook endpoint: inspects webhook secret → looks up user tier → routes to correct agent VPS
- [ ] Per-token usage accounting (tracked by webhook secret ownership)
- [ ] User dashboard on hosted platform (usage stats, billing, repo management)
- [ ] Credit system / billing integration (Stripe or similar)
- [ ] Dedicated agent VPS provisioning (API to spin up/down worker instances)
- [ ] Admin panel for managing tenants and monitoring fleet

**Polish:**
- [ ] Webhook replay / manual trigger API
- [ ] Job priority levels (urgent labels get processed first)
- [ ] Slack/Discord notifications on job completion
