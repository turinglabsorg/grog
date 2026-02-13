import crypto from "node:crypto";
import { Router } from "express";
import type { Request as ExpressRequest, Response as ExpressResponse } from "express";
import type { Config, GrogUser, WebhookRegistration } from "@grog/shared";
import { StateManager, createLogger, encrypt, decrypt, isEncrypted } from "@grog/shared";

const log = createLogger("auth");

const GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GITHUB_API = "https://api.github.com";

// --- Cookie-based session (HMAC-signed) ---

function signCookie(value: string, secret: string): string {
  const sig = crypto.createHmac("sha256", secret).update(value).digest("base64url");
  return `${value}.${sig}`;
}

function verifyCookie(cookie: string, secret: string): string | null {
  const dot = cookie.lastIndexOf(".");
  if (dot === -1) return null;
  const value = cookie.slice(0, dot);
  const sig = cookie.slice(dot + 1);
  const expected = crypto.createHmac("sha256", secret).update(value).digest("base64url");
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  return value;
}

export function getCurrentUser(req: ExpressRequest, config: Config): number | null {
  const raw = parseCookies(req.headers.cookie ?? "")["grog_session"];
  if (!raw) return null;
  const value = verifyCookie(raw, config.sessionSecret);
  if (!value) return null;
  const id = parseInt(value, 10);
  return isNaN(id) ? null : id;
}

function parseCookies(header: string): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const pair of header.split(";")) {
    const [key, ...rest] = pair.trim().split("=");
    if (key) cookies[key] = rest.join("=");
  }
  return cookies;
}

/** Decrypt user access token (backwards-compatible with plaintext tokens). */
export function decryptToken(encryptedOrPlain: string, secret: string): string {
  if (isEncrypted(encryptedOrPlain)) {
    return decrypt(encryptedOrPlain, secret);
  }
  return encryptedOrPlain;
}

// --- GitHub API helpers (using user's OAuth token) ---

async function githubUserApi(token: string, path: string, init?: RequestInit): Promise<globalThis.Response> {
  return fetch(`${GITHUB_API}${path}`, {
    ...init,
    headers: {
      Authorization: `token ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(init?.headers as Record<string, string> ?? {}),
    },
  });
}

// --- Router ---

export function createAuthRouter(config: Config, state: StateManager): Router {
  const router = Router();

  // Step 1: Redirect to GitHub OAuth
  router.get("/auth/github", (_req: ExpressRequest, res: ExpressResponse) => {
    if (!config.githubClientId) {
      res.status(500).json({ error: "GITHUB_CLIENT_ID not configured" });
      return;
    }
    const params = new URLSearchParams({
      client_id: config.githubClientId,
      redirect_uri: `${config.baseUrl}/auth/github/callback`,
      scope: "repo admin:repo_hook read:user",
    });
    res.redirect(`${GITHUB_AUTHORIZE_URL}?${params}`);
  });

  // Step 2: OAuth callback — exchange code for token, fetch user, set cookie
  router.get("/auth/github/callback", async (req: ExpressRequest, res: ExpressResponse) => {
    const code = req.query.code as string;
    if (!code) {
      res.status(400).json({ error: "Missing code parameter" });
      return;
    }

    try {
      // Exchange code for access token
      const tokenRes = await fetch(GITHUB_TOKEN_URL, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          client_id: config.githubClientId,
          client_secret: config.githubClientSecret,
          code,
        }),
      });

      const tokenData = (await tokenRes.json()) as { access_token?: string; error?: string };
      if (!tokenData.access_token) {
        log.error(`OAuth token exchange failed: ${tokenData.error}`);
        res.status(400).json({ error: "OAuth failed", detail: tokenData.error });
        return;
      }

      // Fetch GitHub user profile
      const userRes = await githubUserApi(tokenData.access_token, "/user");
      if (!userRes.ok) {
        res.status(502).json({ error: "Failed to fetch GitHub user" });
        return;
      }
      const ghUser = (await userRes.json()) as {
        id: number;
        login: string;
        avatar_url: string;
      };

      // Encrypt token before storing
      const encryptedToken = encrypt(tokenData.access_token, config.sessionSecret);

      // Upsert user in DB
      const now = new Date().toISOString();
      const existing = await state.getUserByGithubId(ghUser.id);
      const user: GrogUser = {
        githubId: ghUser.id,
        login: ghUser.login,
        accessToken: encryptedToken,
        avatarUrl: ghUser.avatar_url,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      await state.upsertUser(user);

      log.info(`User logged in: ${ghUser.login} (${ghUser.id})`);

      // Set signed session cookie
      const cookieValue = signCookie(String(ghUser.id), config.sessionSecret);
      const csrfToken = crypto.randomBytes(32).toString("hex");
      const maxAge = 30 * 24 * 3600;
      res.setHeader("Set-Cookie", [
        `grog_session=${cookieValue}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`,
        `grog_csrf=${csrfToken}; Path=/; SameSite=Lax; Max-Age=${maxAge}`,
      ]);

      res.redirect("/");
    } catch (err) {
      log.error(`OAuth callback error: ${err}`);
      res.status(500).json({ error: "OAuth callback failed" });
    }
  });

  // Current user info
  router.get("/auth/me", async (req: ExpressRequest, res: ExpressResponse) => {
    const githubId = getCurrentUser(req, config);
    if (!githubId) {
      res.status(401).json({ error: "Not authenticated" });
      return;
    }
    const user = await state.getUserByGithubId(githubId);
    if (!user) {
      res.status(401).json({ error: "User not found" });
      return;
    }
    res.json({
      githubId: user.githubId,
      login: user.login,
      avatarUrl: user.avatarUrl,
    });
  });

  // Logout
  router.post("/auth/logout", (_req: ExpressRequest, res: ExpressResponse) => {
    res.setHeader(
      "Set-Cookie",
      "grog_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0"
    );
    res.json({ ok: true });
  });

  // --- Repo Setup Flow ---

  // List user's repos (from GitHub, not local config)
  router.get("/auth/repos", async (req: ExpressRequest, res: ExpressResponse) => {
    const githubId = getCurrentUser(req, config);
    if (!githubId) {
      res.status(401).json({ error: "Not authenticated" });
      return;
    }
    const user = await state.getUserByGithubId(githubId);
    if (!user) {
      res.status(401).json({ error: "User not found" });
      return;
    }

    try {
      const plainToken = decryptToken(user.accessToken, config.sessionSecret);
      // Fetch repos the user has admin access to
      const repos: { full_name: string; private: boolean }[] = [];
      let page = 1;
      while (page <= 5) {
        const repoRes = await githubUserApi(
          plainToken,
          `/user/repos?per_page=100&page=${page}&sort=updated&affiliation=owner,organization_member`
        );
        if (!repoRes.ok) break;
        const batch = (await repoRes.json()) as {
          full_name: string;
          private: boolean;
          permissions?: { admin?: boolean };
        }[];
        if (batch.length === 0) break;
        repos.push(
          ...batch
            .filter((r) => r.permissions?.admin)
            .map((r) => ({ full_name: r.full_name, private: r.private }))
        );
        page++;
      }

      // Also fetch existing webhook registrations for this user
      const registrations = await state.listWebhooksByUser(githubId);
      const setupRepoIds = new Set(registrations.map((r) => r.repoId));

      res.json(
        repos.map((r) => ({
          ...r,
          setup: setupRepoIds.has(r.full_name),
        }))
      );
    } catch (err) {
      log.error(`Failed to list repos: ${err}`);
      res.status(502).json({ error: "Failed to list repos from GitHub" });
    }
  });

  // Setup a repo: invite grog bot + create webhook with unique secret
  router.post("/auth/repos/:owner/:repo/setup", async (req: ExpressRequest, res: ExpressResponse) => {
    const githubId = getCurrentUser(req, config);
    if (!githubId) {
      res.status(401).json({ error: "Not authenticated" });
      return;
    }
    const user = await state.getUserByGithubId(githubId);
    if (!user) {
      res.status(401).json({ error: "User not found" });
      return;
    }

    const owner = req.params.owner as string;
    const repo = req.params.repo as string;
    const repoId = `${owner}/${repo}`;

    try {
      const plainToken = decryptToken(user.accessToken, config.sessionSecret);
      // 1. Invite grog bot as a collaborator
      const inviteRes = await githubUserApi(
        plainToken,
        `/repos/${owner}/${repo}/collaborators/${config.botUsername}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ permission: "push" }),
        }
      );
      if (!inviteRes.ok && inviteRes.status !== 422) {
        // 422 = already a collaborator
        const errText = await inviteRes.text();
        log.error(`Failed to invite bot to ${repoId}: ${inviteRes.status} ${errText}`);
        res.status(502).json({ error: `Failed to invite bot: ${inviteRes.status}` });
        return;
      }
      log.info(`Invited ${config.botUsername} to ${repoId}`);

      // 2. Generate unique webhook secret
      const webhookSecret = crypto.randomBytes(32).toString("hex");

      // 3. Create webhook on the repo
      const hookRes = await githubUserApi(
        plainToken,
        `/repos/${owner}/${repo}/hooks`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: "web",
            active: true,
            events: ["issue_comment", "issues", "pull_request"],
            config: {
              url: `${config.baseUrl}/webhook`,
              content_type: "json",
              secret: webhookSecret,
              insecure_ssl: "0",
            },
          }),
        }
      );

      if (!hookRes.ok) {
        const errText = await hookRes.text();
        log.error(`Failed to create webhook for ${repoId}: ${hookRes.status} ${errText}`);
        res.status(502).json({ error: `Failed to create webhook: ${hookRes.status}` });
        return;
      }

      const hook = (await hookRes.json()) as { id: number };

      // 4. Store webhook registration
      const registration: WebhookRegistration = {
        repoId,
        webhookSecret,
        userId: githubId,
        userLogin: user.login,
        webhookId: hook.id,
        createdAt: new Date().toISOString(),
      };
      await state.upsertWebhookRegistration(registration);

      // 5. Also create a default repo config if none exists
      const existingConfig = await state.getRepoConfig(owner, repo);
      if (!existingConfig) {
        const now = new Date().toISOString();
        await state.upsertRepoConfig({
          id: repoId,
          owner,
          repo,
          enabled: true,
          autoSolve: false,
          includeLabels: [],
          excludeLabels: [],
          allowedUsers: [],
          createdAt: now,
          updatedAt: now,
        });
      }

      log.info(`Repo setup complete: ${repoId} (webhook ${hook.id})`);
      res.json({ ok: true, repoId, webhookId: hook.id });
    } catch (err) {
      log.error(`Repo setup failed for ${repoId}: ${err}`);
      res.status(500).json({ error: "Repo setup failed" });
    }
  });

  // Remove repo setup: delete webhook
  router.delete("/auth/repos/:owner/:repo/setup", async (req: ExpressRequest, res: ExpressResponse) => {
    const githubId = getCurrentUser(req, config);
    if (!githubId) {
      res.status(401).json({ error: "Not authenticated" });
      return;
    }
    const user = await state.getUserByGithubId(githubId);
    if (!user) {
      res.status(401).json({ error: "User not found" });
      return;
    }

    const owner = req.params.owner as string;
    const repo = req.params.repo as string;
    const repoId = `${owner}/${repo}`;

    const reg = await state.getWebhookByRepoId(repoId);
    if (!reg) {
      res.status(404).json({ error: "No webhook registration for this repo" });
      return;
    }

    if (reg.userId !== githubId) {
      res.status(403).json({ error: "Not authorized to remove this webhook" });
      return;
    }

    try {
      const plainToken = decryptToken(user.accessToken, config.sessionSecret);
      // Delete webhook from GitHub
      const delRes = await githubUserApi(
        plainToken,
        `/repos/${owner}/${repo}/hooks/${reg.webhookId}`,
        { method: "DELETE" }
      );
      if (!delRes.ok && delRes.status !== 404) {
        log.error(`Failed to delete webhook ${reg.webhookId}: ${delRes.status}`);
      }

      await state.deleteWebhookRegistration(repoId);
      log.info(`Webhook removed for ${repoId}`);
      res.json({ ok: true, repoId });
    } catch (err) {
      log.error(`Failed to remove webhook for ${repoId}: ${err}`);
      res.status(500).json({ error: "Failed to remove webhook" });
    }
  });

  return router;
}
