import crypto from "node:crypto";
import { createLogger } from "./logger.js";

const log = createLogger("github-app");
const API = "https://api.github.com";

// --- JWT Generation (RS256) ---

function generateJWT(appId: string, privateKey: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iat: now - 60, // 60s in the past for clock drift
    exp: now + 600, // 10 minutes (GitHub max)
    iss: appId,
  };

  const b64url = (obj: object) =>
    Buffer.from(JSON.stringify(obj)).toString("base64url");

  const unsigned = `${b64url(header)}.${b64url(payload)}`;
  const signature = crypto
    .sign("sha256", Buffer.from(unsigned), privateKey)
    .toString("base64url");

  return `${unsigned}.${signature}`;
}

// --- Installation Token Cache ---

interface CachedToken {
  token: string;
  expiresAt: number; // epoch ms
}

let tokenCache: CachedToken | null = null;

/**
 * Get a valid installation access token.
 * Caches the token and refreshes 5 minutes before expiry.
 */
export async function getInstallationToken(
  appId: string,
  privateKey: string,
  installationId: number
): Promise<string> {
  // Return cached token if still valid (with 5-min buffer)
  if (tokenCache && tokenCache.expiresAt - Date.now() > 5 * 60 * 1000) {
    return tokenCache.token;
  }

  log.info("Generating new installation access token");
  const jwt = generateJWT(appId, privateKey);

  const res = await fetch(
    `${API}/app/installations/${installationId}/access_tokens`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github+json",
      },
    }
  );

  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      `Failed to create installation token: ${res.status} — ${body.slice(0, 200)}`
    );
  }

  const data = (await res.json()) as { token: string; expires_at: string };
  tokenCache = {
    token: data.token,
    expiresAt: new Date(data.expires_at).getTime(),
  };

  log.info(
    `Installation token obtained (expires ${data.expires_at})`
  );
  return tokenCache.token;
}

/** Clear the cached token (e.g. on config change). */
export function clearTokenCache(): void {
  tokenCache = null;
}

// --- App Info ---

export interface AppInfo {
  id: number;
  slug: string;
  name: string;
  owner: { login: string };
}

/** Get the authenticated GitHub App's info. */
export async function getAppInfo(
  appId: string,
  privateKey: string
): Promise<AppInfo> {
  const jwt = generateJWT(appId, privateKey);
  const res = await fetch(`${API}/app`, {
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: "application/vnd.github+json",
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      `Failed to get app info: ${res.status} — ${body.slice(0, 200)}`
    );
  }

  return (await res.json()) as AppInfo;
}

// --- Installations ---

export interface Installation {
  id: number;
  account: { login: string; type: string };
  app_id: number;
  target_type: string;
  repository_selection: string;
}

/** List all installations for this GitHub App. */
export async function listInstallations(
  appId: string,
  privateKey: string
): Promise<Installation[]> {
  const jwt = generateJWT(appId, privateKey);
  const res = await fetch(`${API}/app/installations`, {
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: "application/vnd.github+json",
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      `Failed to list installations: ${res.status} — ${body.slice(0, 200)}`
    );
  }

  return (await res.json()) as Installation[];
}

// --- Rate Limit Check ---

export async function checkRateLimit(token: string): Promise<{
  limit: number;
  remaining: number;
  reset: number;
}> {
  const res = await fetch(`${API}/rate_limit`, {
    headers: {
      Authorization: `token ${token}`,
      Accept: "application/vnd.github+json",
    },
  });

  if (!res.ok) {
    throw new Error(`Failed to check rate limit: ${res.status}`);
  }

  const data = (await res.json()) as {
    resources: { core: { limit: number; remaining: number; reset: number } };
  };
  return data.resources.core;
}
