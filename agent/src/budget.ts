import type { Config } from "./types.js";
import { StateManager } from "./state.js";
import { createLogger } from "./logger.js";

const log = createLogger("budget");

export interface BudgetStatus {
  hourlyUsed: number;
  hourlyLimit: number;
  dailyUsed: number;
  dailyLimit: number;
  paused: boolean;
  resumesAt: string | null;
}

export class TokenBudget {
  private config: Config;
  private state: StateManager;

  constructor(config: Config, state: StateManager) {
    this.config = config;
    this.state = state;
  }

  async getUsage(): Promise<{ hourly: number; daily: number }> {
    const jobs = await this.state.listJobs();
    const now = Date.now();
    const oneHourAgo = now - 60 * 60 * 1000;
    const oneDayAgo = now - 24 * 60 * 60 * 1000;

    let hourly = 0;
    let daily = 0;

    for (const job of jobs) {
      if (!job.tokenUsage) continue;
      const total = job.tokenUsage.inputTokens + job.tokenUsage.outputTokens;
      const jobTime = new Date(job.updatedAt).getTime();

      if (jobTime >= oneDayAgo) {
        daily += total;
      }
      if (jobTime >= oneHourAgo) {
        hourly += total;
      }
    }

    return { hourly, daily };
  }

  async canRun(): Promise<boolean> {
    const { hourlyLimit, dailyLimit } = this.getLimits();

    // 0 means no limit
    if (hourlyLimit === 0 && dailyLimit === 0) return true;

    const usage = await this.getUsage();

    if (hourlyLimit > 0 && usage.hourly >= hourlyLimit) {
      log.warn(`Hourly token budget exceeded: ${usage.hourly.toLocaleString()} / ${hourlyLimit.toLocaleString()}`);
      return false;
    }
    if (dailyLimit > 0 && usage.daily >= dailyLimit) {
      log.warn(`Daily token budget exceeded: ${usage.daily.toLocaleString()} / ${dailyLimit.toLocaleString()}`);
      return false;
    }

    return true;
  }

  async getStatus(): Promise<BudgetStatus> {
    const { hourlyLimit, dailyLimit } = this.getLimits();
    const usage = await this.getUsage();

    const hourlyExceeded = hourlyLimit > 0 && usage.hourly >= hourlyLimit;
    const dailyExceeded = dailyLimit > 0 && usage.daily >= dailyLimit;
    const paused = hourlyExceeded || dailyExceeded;

    let resumesAt: string | null = null;
    if (paused) {
      // Estimate when budget resets
      const now = new Date();
      if (hourlyExceeded) {
        const resume = new Date(now.getTime() + 60 * 60 * 1000);
        resumesAt = resume.toISOString();
      }
      if (dailyExceeded) {
        const resume = new Date(now.getTime() + 24 * 60 * 60 * 1000);
        if (!resumesAt || resume.toISOString() > resumesAt) {
          resumesAt = resume.toISOString();
        }
      }
    }

    return {
      hourlyUsed: usage.hourly,
      hourlyLimit,
      dailyUsed: usage.daily,
      dailyLimit,
      paused,
      resumesAt,
    };
  }

  private getLimits() {
    return {
      hourlyLimit: this.config.hourlyTokenBudget,
      dailyLimit: this.config.dailyTokenBudget,
    };
  }
}
