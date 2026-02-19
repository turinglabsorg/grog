import express from "express";
import cors from "cors";
import {
  loadConfig,
  StateManager,
  createLogger,
} from "@grog/shared";
import { createAuthRouter } from "./auth.js";
import { requireAuth, requireAdmin, csrfProtection, rateLimit } from "./middleware.js";
import { createBillingRouter } from "./billing.js";
import { registerStripeWebhook } from "./stripeWebhook.js";

const log = createLogger("api");

async function main() {
  const config = loadConfig();
  const state = await StateManager.connect(config.mongodbUri);

  const app = express();

  // CORS — allow the React frontend to call the API
  app.use(cors({
    origin: config.frontendUrl || "http://localhost:5173",
    credentials: true,
  }));

  // Register Stripe webhook BEFORE global JSON parser (needs raw body)
  registerStripeWebhook(app, config, state);

  // Parse JSON
  app.use(express.json());

  // Global rate limit
  app.use(rateLimit(60_000, 120));

  // CSRF protection
  app.use(csrfProtection());

  // Auth routes (OAuth + repo setup) — strict rate limit on auth endpoints
  const authLimiter = rateLimit(60_000, 10);
  app.use("/auth", authLimiter);
  app.use(createAuthRouter(config, state));

  // Billing routes
  app.use(createBillingRouter(config, state));

  // Admin stats
  app.get("/admin/stats", requireAuth(config, state), requireAdmin(config), async (_req, res) => {
    res.json(await state.getStats());
  });

  // Admin grant credits
  app.post("/admin/grant-credits", requireAuth(config, state), requireAdmin(config), async (req, res) => {
    const { login, amount } = req.body as { login?: string; amount?: number };

    if (!login || typeof login !== "string") {
      res.status(400).json({ error: "login is required" });
      return;
    }
    if (!amount || typeof amount !== "number" || amount <= 0 || !Number.isInteger(amount)) {
      res.status(400).json({ error: "amount must be a positive integer" });
      return;
    }

    const user = await state.getUserByLogin(login);
    if (!user) {
      res.status(404).json({ error: `User not found: ${login}` });
      return;
    }

    const balance = await state.addCredits(user.githubId, amount);
    await state.recordCreditTransaction({
      id: `grant-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      userId: user.githubId,
      type: "grant",
      amount,
      balanceAfter: balance.credits,
      description: `Admin grant of ${amount} credits`,
      createdAt: new Date().toISOString(),
    });

    log.info(`Admin granted ${amount} credits to ${login} (${user.githubId})`);
    res.json({ login, githubId: user.githubId, credits: balance.credits });
  });

  // Health check
  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  const port = config.apiPort || 3001;
  app.listen(port, () => {
    log.info(`Grog API server listening on port ${port}`);
  });
}

main().catch((err) => {
  log.error(`Failed to start Grog API: ${err}`);
  process.exit(1);
});
