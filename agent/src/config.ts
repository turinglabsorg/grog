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
  return {
    ghToken: requireEnv("GH_TOKEN"),
    webhookSecret: requireEnv("WEBHOOK_SECRET"),
    botUsername: process.env.BOT_USERNAME ?? "grog",
    port: parseInt(process.env.PORT ?? "3000", 10),
    maxConcurrentJobs: parseInt(process.env.MAX_CONCURRENT_JOBS ?? "2", 10),
    workDir: process.env.WORK_DIR ?? "/tmp/grog-jobs",
    mongodbUri: process.env.MONGODB_URI ?? "mongodb://localhost:27017/grog",
  };
}
