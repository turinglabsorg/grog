import { MongoClient, Collection, Db } from "mongodb";
import type { JobState, JobStatus, RepoConfig, GrogUser, WebhookRegistration, CreditBalance, CreditTransaction, AppConfig } from "./types.js";
import type { OutputLine } from "./outputStore.js";
import { createLogger } from "./logger.js";

const log = createLogger("state");

interface JobLogDoc {
  jobId: string;
  lines: OutputLine[];
}

export class StateManager {
  private collection: Collection<JobState>;
  private logsCollection: Collection<JobLogDoc>;
  private repoConfigCollection: Collection<RepoConfig>;
  private usersCollection: Collection<GrogUser>;
  private webhooksCollection: Collection<WebhookRegistration>;
  private creditBalances: Collection<CreditBalance>;
  private creditTransactions: Collection<CreditTransaction>;
  private configCollection: Collection<AppConfig>;
  private db: Db;

  private constructor(
    db: Db,
    collection: Collection<JobState>,
    logsCollection: Collection<JobLogDoc>,
    repoConfigCollection: Collection<RepoConfig>,
    usersCollection: Collection<GrogUser>,
    webhooksCollection: Collection<WebhookRegistration>,
    creditBalances: Collection<CreditBalance>,
    creditTransactions: Collection<CreditTransaction>,
    configCollection: Collection<AppConfig>
  ) {
    this.db = db;
    this.collection = collection;
    this.logsCollection = logsCollection;
    this.repoConfigCollection = repoConfigCollection;
    this.usersCollection = usersCollection;
    this.webhooksCollection = webhooksCollection;
    this.creditBalances = creditBalances;
    this.creditTransactions = creditTransactions;
    this.configCollection = configCollection;
  }

  static async connect(uri: string): Promise<StateManager> {
    const client = new MongoClient(uri);
    await client.connect();
    const db = client.db();
    const collection = db.collection<JobState>("jobs");
    const logsCollection = db.collection<JobLogDoc>("job_logs");
    const repoConfigCollection = db.collection<RepoConfig>("repo_configs");
    const usersCollection = db.collection<GrogUser>("users");
    const webhooksCollection = db.collection<WebhookRegistration>("webhook_registrations");
    const creditBalances = db.collection<CreditBalance>("credit_balances");
    const creditTransactions = db.collection<CreditTransaction>("credit_transactions");
    const configCollection = db.collection<AppConfig>("config");

    // Create indexes
    await collection.createIndex(
      { owner: 1, repo: 1, issueNumber: 1 },
      { unique: true }
    );
    await collection.createIndex({ status: 1 });
    await collection.createIndex({ prUrl: 1 }, { sparse: true });
    await collection.createIndex({ branch: 1 }, { sparse: true });
    await collection.createIndex({ updatedAt: 1 });

    await logsCollection.createIndex({ jobId: 1 }, { unique: true });
    await repoConfigCollection.createIndex({ id: 1 }, { unique: true });
    await usersCollection.createIndex({ githubId: 1 }, { unique: true });
    await webhooksCollection.createIndex({ repoId: 1 }, { unique: true });
    await webhooksCollection.createIndex({ webhookSecret: 1 });

    // Credit indexes
    await creditBalances.createIndex({ userId: 1 }, { unique: true });
    await creditTransactions.createIndex({ userId: 1, createdAt: -1 });
    await creditTransactions.createIndex({ stripeSessionId: 1 }, { sparse: true });
    await creditTransactions.createIndex({ jobId: 1 }, { sparse: true });

    await configCollection.createIndex({ id: 1 }, { unique: true });

    log.info("Connected to MongoDB");
    return new StateManager(db, collection, logsCollection, repoConfigCollection, usersCollection, webhooksCollection, creditBalances, creditTransactions, configCollection);
  }

  async getJob(
    owner: string,
    repo: string,
    issueNumber: number
  ): Promise<JobState | undefined> {
    const doc = await this.collection.findOne(
      { owner, repo, issueNumber },
      { projection: { _id: 0 } }
    );
    return doc ?? undefined;
  }

  async getJobById(id: string): Promise<JobState | undefined> {
    const doc = await this.collection.findOne(
      { id },
      { projection: { _id: 0 } }
    );
    return doc ?? undefined;
  }

  async upsertJob(job: JobState): Promise<void> {
    await this.collection.updateOne(
      { id: job.id },
      { $set: job },
      { upsert: true }
    );
  }

  async listJobs(): Promise<JobState[]> {
    return this.collection.find({}, { projection: { _id: 0 } }).toArray();
  }

  async listActiveJobs(): Promise<JobState[]> {
    return this.collection
      .find(
        { status: { $nin: ["completed", "failed", "closed", "stopped"] } },
        { projection: { _id: 0 } }
      )
      .toArray();
  }

  async removeJob(id: string): Promise<void> {
    await this.collection.deleteOne({ id });
  }

  async getJobByPrUrl(prUrl: string): Promise<JobState | undefined> {
    const doc = await this.collection.findOne(
      { prUrl },
      { projection: { _id: 0 } }
    );
    return doc ?? undefined;
  }

  async getJobByBranch(
    owner: string,
    repo: string,
    branch: string
  ): Promise<JobState | undefined> {
    const doc = await this.collection.findOne(
      { owner, repo, branch },
      { projection: { _id: 0 } }
    );
    return doc ?? undefined;
  }

  /** Atomically claim the next queued job (oldest first). Returns null if none available. */
  async claimNextJob(): Promise<JobState | null> {
    const result = await this.collection.findOneAndUpdate(
      { status: "queued" },
      { $set: { status: "working" as JobStatus, updatedAt: new Date().toISOString() } },
      { sort: { startedAt: 1 }, returnDocument: "after", projection: { _id: 0 } }
    );
    return result ?? null;
  }

  async appendJobLog(jobId: string, line: OutputLine): Promise<void> {
    await this.logsCollection.updateOne(
      { jobId },
      { $push: { lines: line } },
      { upsert: true }
    );
  }

  async getJobLogs(jobId: string): Promise<OutputLine[]> {
    const doc = await this.logsCollection.findOne(
      { jobId },
      { projection: { _id: 0 } }
    );
    return doc?.lines ?? [];
  }

  // --- Repo Config ---

  async getRepoConfig(owner: string, repo: string): Promise<RepoConfig | undefined> {
    const id = `${owner}/${repo}`;
    const doc = await this.repoConfigCollection.findOne(
      { id },
      { projection: { _id: 0 } }
    );
    return doc ?? undefined;
  }

  async upsertRepoConfig(config: RepoConfig): Promise<void> {
    await this.repoConfigCollection.updateOne(
      { id: config.id },
      { $set: config },
      { upsert: true }
    );
  }

  async listRepoConfigs(): Promise<RepoConfig[]> {
    return this.repoConfigCollection.find({}, { projection: { _id: 0 } }).toArray();
  }

  async deleteRepoConfig(id: string): Promise<boolean> {
    const result = await this.repoConfigCollection.deleteOne({ id });
    return result.deletedCount > 0;
  }

  // --- Users ---

  async upsertUser(user: GrogUser): Promise<void> {
    await this.usersCollection.updateOne(
      { githubId: user.githubId },
      { $set: user },
      { upsert: true }
    );
  }

  async getUserByGithubId(githubId: number): Promise<GrogUser | undefined> {
    const doc = await this.usersCollection.findOne(
      { githubId },
      { projection: { _id: 0 } }
    );
    return doc ?? undefined;
  }

  async getUserByLogin(login: string): Promise<GrogUser | undefined> {
    const doc = await this.usersCollection.findOne(
      { login },
      { projection: { _id: 0 } }
    );
    return doc ?? undefined;
  }

  // --- Webhook Registrations ---

  async upsertWebhookRegistration(reg: WebhookRegistration): Promise<void> {
    await this.webhooksCollection.updateOne(
      { repoId: reg.repoId },
      { $set: reg },
      { upsert: true }
    );
  }

  async getWebhookByRepoId(repoId: string): Promise<WebhookRegistration | undefined> {
    const doc = await this.webhooksCollection.findOne(
      { repoId },
      { projection: { _id: 0 } }
    );
    return doc ?? undefined;
  }

  async getWebhookBySecret(secret: string): Promise<WebhookRegistration | undefined> {
    const doc = await this.webhooksCollection.findOne(
      { webhookSecret: secret },
      { projection: { _id: 0 } }
    );
    return doc ?? undefined;
  }

  async listWebhooksByUser(userId: number): Promise<WebhookRegistration[]> {
    return this.webhooksCollection
      .find({ userId }, { projection: { _id: 0 } })
      .toArray();
  }

  async deleteWebhookRegistration(repoId: string): Promise<boolean> {
    const result = await this.webhooksCollection.deleteOne({ repoId });
    return result.deletedCount > 0;
  }

  // --- Admin: bulk job operations ---

  async bulkUpdateJobStatus(
    filter: { status?: string; owner?: string; repo?: string },
    newStatus: JobStatus
  ): Promise<number> {
    const query: Record<string, unknown> = {};
    if (filter.status) query.status = filter.status;
    if (filter.owner) query.owner = filter.owner;
    if (filter.repo) query.repo = filter.repo;

    const result = await this.collection.updateMany(query, {
      $set: { status: newStatus, updatedAt: new Date().toISOString() },
    });
    return result.modifiedCount;
  }

  async purgeJobs(olderThanDays: number): Promise<number> {
    const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000).toISOString();
    const result = await this.collection.deleteMany({
      status: { $in: ["completed", "failed", "closed"] },
      updatedAt: { $lt: cutoff },
    });

    // Also purge associated logs
    if (result.deletedCount > 0) {
      const remainingJobIds = (await this.listJobs()).map((j) => j.id);
      await this.logsCollection.deleteMany({
        jobId: { $nin: remainingJobIds },
      });
    }

    return result.deletedCount;
  }

  async getStats(): Promise<{
    totalJobs: number;
    byStatus: Record<string, number>;
    byRepo: Record<string, number>;
    totalTokens: { input: number; output: number };
  }> {
    const jobs = await this.listJobs();
    const byStatus: Record<string, number> = {};
    const byRepo: Record<string, number> = {};
    let totalInput = 0;
    let totalOutput = 0;

    for (const job of jobs) {
      byStatus[job.status] = (byStatus[job.status] ?? 0) + 1;
      const repoKey = `${job.owner}/${job.repo}`;
      byRepo[repoKey] = (byRepo[repoKey] ?? 0) + 1;
      if (job.tokenUsage) {
        totalInput += job.tokenUsage.inputTokens;
        totalOutput += job.tokenUsage.outputTokens;
      }
    }

    return {
      totalJobs: jobs.length,
      byStatus,
      byRepo,
      totalTokens: { input: totalInput, output: totalOutput },
    };
  }

  // --- Token usage aggregation (1.8) ---

  async getTokenUsageSince(sinceIso: string): Promise<number> {
    const pipeline = [
      {
        $match: {
          updatedAt: { $gte: sinceIso },
          "tokenUsage.inputTokens": { $exists: true },
        },
      },
      {
        $group: {
          _id: null,
          total: {
            $sum: {
              $add: ["$tokenUsage.inputTokens", "$tokenUsage.outputTokens"],
            },
          },
        },
      },
    ];
    const results = await this.collection.aggregate(pipeline).toArray();
    return results.length > 0 ? (results[0] as { total: number }).total : 0;
  }

  // --- Stale job recovery (1.9) ---

  async recoverStaleJobs(staleAfterMinutes: number): Promise<number> {
    const cutoff = new Date(Date.now() - staleAfterMinutes * 60 * 1000).toISOString();
    const result = await this.collection.updateMany(
      { status: "working", updatedAt: { $lt: cutoff } },
      { $set: { status: "queued" as JobStatus, updatedAt: new Date().toISOString() } }
    );
    if (result.modifiedCount > 0) {
      log.info(`Recovered ${result.modifiedCount} stale job(s)`);
    }
    return result.modifiedCount;
  }

  // --- Credit Balance ---

  async getCreditBalance(userId: number): Promise<CreditBalance | undefined> {
    const doc = await this.creditBalances.findOne(
      { userId },
      { projection: { _id: 0 } }
    );
    return doc ?? undefined;
  }

  async ensureCreditBalance(userId: number): Promise<CreditBalance> {
    const existing = await this.getCreditBalance(userId);
    if (existing) return existing;
    const now = new Date().toISOString();
    const balance: CreditBalance = {
      userId,
      credits: 0,
      lifetimePurchased: 0,
      lifetimeUsed: 0,
      updatedAt: now,
    };
    await this.creditBalances.updateOne(
      { userId },
      { $setOnInsert: balance },
      { upsert: true }
    );
    return (await this.getCreditBalance(userId)) ?? balance;
  }

  async addCredits(userId: number, amount: number): Promise<CreditBalance> {
    await this.creditBalances.updateOne(
      { userId },
      {
        $inc: { credits: amount, lifetimePurchased: amount },
        $set: { updatedAt: new Date().toISOString() },
        $setOnInsert: { lifetimeUsed: 0 },
      },
      { upsert: true }
    );
    return (await this.getCreditBalance(userId))!;
  }

  async deductCredits(userId: number, amount: number): Promise<boolean> {
    const result = await this.creditBalances.updateOne(
      { userId, credits: { $gte: amount } },
      {
        $inc: { credits: -amount, lifetimeUsed: amount },
        $set: { updatedAt: new Date().toISOString() },
      }
    );
    return result.modifiedCount > 0;
  }

  async recordCreditTransaction(tx: CreditTransaction): Promise<void> {
    await this.creditTransactions.insertOne(tx as any);
  }

  async getCreditTransactions(userId: number, limit = 50): Promise<CreditTransaction[]> {
    return this.creditTransactions
      .find({ userId }, { projection: { _id: 0 } })
      .sort({ createdAt: -1 })
      .limit(limit)
      .toArray();
  }

  async getTransactionByStripeSession(sessionId: string): Promise<CreditTransaction | undefined> {
    const doc = await this.creditTransactions.findOne(
      { stripeSessionId: sessionId },
      { projection: { _id: 0 } }
    );
    return doc ?? undefined;
  }

  // --- App Config (singleton) ---

  async getAppConfig(): Promise<AppConfig | undefined> {
    const doc = await this.configCollection.findOne(
      { id: "github-app" },
      { projection: { _id: 0 } }
    );
    return doc ?? undefined;
  }

  async saveAppConfig(config: AppConfig): Promise<void> {
    await this.configCollection.updateOne(
      { id: "github-app" },
      { $set: config },
      { upsert: true }
    );
  }

  async deleteAppConfig(): Promise<boolean> {
    const result = await this.configCollection.deleteOne({ id: "github-app" });
    return result.deletedCount > 0;
  }
}
