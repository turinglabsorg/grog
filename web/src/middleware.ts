import crypto from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import type { Config } from "@grog/shared";
import { StateManager } from "@grog/shared";
import { getCurrentUser } from "./auth.js";

// --- Auth Middleware (1.3) ---

export function requireAuth(config: Config, state: StateManager) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const githubId = getCurrentUser(req, config);
    if (!githubId) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    const user = await state.getUserByGithubId(githubId);
    if (!user) {
      res.status(401).json({ error: "User not found" });
      return;
    }
    (req as any).grogUser = user;
    (req as any).grogUserId = githubId;
    next();
  };
}

export function requireAdmin(config: Config) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const userId = (req as any).grogUserId as number | undefined;
    if (!userId) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    if (config.adminGithubIds.length > 0 && !config.adminGithubIds.includes(userId)) {
      res.status(403).json({ error: "Admin access required" });
      return;
    }
    next();
  };
}

// --- CSRF Protection (1.4) ---

const CSRF_BYPASS_PATHS = ["/webhook", "/billing/webhook"];

export function csrfProtection() {
  return (req: Request, res: Response, next: NextFunction): void => {
    // Only apply to mutating methods
    if (!["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) {
      next();
      return;
    }

    // Skip webhook endpoints (they have their own auth)
    if (CSRF_BYPASS_PATHS.some((p) => req.path === p)) {
      next();
      return;
    }

    const cookieHeader = req.headers.cookie ?? "";
    const cookies: Record<string, string> = {};
    for (const pair of cookieHeader.split(";")) {
      const [key, ...rest] = pair.trim().split("=");
      if (key) cookies[key] = rest.join("=");
    }

    const cookieToken = cookies["grog_csrf"];
    const headerToken = req.headers["x-csrf-token"] as string | undefined;

    if (!cookieToken || !headerToken || cookieToken !== headerToken) {
      res.status(403).json({ error: "CSRF validation failed" });
      return;
    }

    next();
  };
}

// --- Rate Limiting (1.10) ---

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

export function rateLimit(windowMs: number, max: number) {
  const store = new Map<string, RateLimitEntry>();

  // Periodically clean up expired entries
  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of store) {
      if (entry.resetAt <= now) store.delete(key);
    }
  }, 60_000).unref();

  return (req: Request, res: Response, next: NextFunction): void => {
    const ip = req.ip ?? req.socket.remoteAddress ?? "unknown";
    const now = Date.now();
    let entry = store.get(ip);

    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      store.set(ip, entry);
    }

    entry.count++;

    if (entry.count > max) {
      res.status(429).json({ error: "Too many requests" });
      return;
    }

    next();
  };
}
