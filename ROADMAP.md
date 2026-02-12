# Grog Roadmap

## Phase 1 — Webhook Agent (current)

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

## Phase 2 — Hardening

- [x] Error recovery and retry logic (retryable error classification, auto re-enqueue)
- [x] Timeout handling for long-running agents (configurable `AGENT_TIMEOUT_MINUTES`, SIGTERM/SIGKILL)
- [x] Logging (structured JSON logs via `LOG_FORMAT=json`, per-component logger)
- [x] PM2 ecosystem config for VPS deployment (`ecosystem.config.cjs`)
- [x] Rate limiting to respect Claude subscription limits (daily/hourly token budgets, dashboard indicator)
- [x] GitHub API rate limit handling (exponential backoff with jitter, `Retry-After` / `x-ratelimit-reset` support)

## Phase 3 — Multi-repo & Org-wide

- [ ] Org-level webhook support (single endpoint for all repos)
- [ ] Per-repo configuration (which issues to auto-solve, labels to filter)
- [ ] Admin API for bulk job management
