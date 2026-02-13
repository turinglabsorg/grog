import "dotenv/config";
import type { Config } from "./types.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required environment variable: ${name}`);
    process.exit(1);
  }
  return value;
}

export function loadConfig(): Config {
  const githubClientId = process.env.GITHUB_CLIENT_ID ?? "";
  const sessionSecret = process.env.SESSION_SECRET ?? "";

  // If OAuth is enabled, SESSION_SECRET is mandatory
  if (githubClientId && !sessionSecret) {
    console.error("FATAL: GITHUB_CLIENT_ID is set but SESSION_SECRET is missing. Set a random SESSION_SECRET.");
    process.exit(1);
  }

  const adminIds = process.env.ADMIN_GITHUB_IDS ?? "";

  return {
    ghToken: process.env.GH_TOKEN ?? "",
    webhookSecret: process.env.WEBHOOK_SECRET ?? "",
    botUsername: process.env.BOT_USERNAME ?? "grog",
    port: parseInt(process.env.PORT ?? "3000", 10),
    maxConcurrentJobs: parseInt(process.env.MAX_CONCURRENT_JOBS ?? "2", 10),
    workDir: process.env.WORK_DIR ?? "/tmp/grog-jobs",
    mongodbUri: process.env.MONGODB_URI ?? "mongodb://localhost:27017/grog",
    agentTimeoutMinutes: parseInt(process.env.AGENT_TIMEOUT_MINUTES ?? "30", 10),
    maxRetries: parseInt(process.env.MAX_RETRIES ?? "2", 10),
    dailyTokenBudget: parseInt(process.env.DAILY_TOKEN_BUDGET ?? "0", 10),
    hourlyTokenBudget: parseInt(process.env.HOURLY_TOKEN_BUDGET ?? "0", 10),
    githubClientId,
    githubClientSecret: process.env.GITHUB_CLIENT_SECRET ?? "",
    sessionSecret: sessionSecret || "grog-session-secret-placeholder",
    baseUrl: process.env.BASE_URL ?? "http://localhost:3000",
    adminGithubIds: adminIds ? adminIds.split(",").map((s) => parseInt(s.trim(), 10)).filter((n) => !isNaN(n)) : [],
    stripeSecretKey: process.env.STRIPE_SECRET_KEY ?? "",
    stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET ?? "",
    billingEnabled: !!process.env.STRIPE_SECRET_KEY,
  };
}
