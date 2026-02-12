import { MongoClient, Collection } from "mongodb";
import type { JobState, JobStatus, RepoConfig } from "./types.js";
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

  private constructor(
    collection: Collection<JobState>,
    logsCollection: Collection<JobLogDoc>,
    repoConfigCollection: Collection<RepoConfig>
  ) {
    this.collection = collection;
    this.logsCollection = logsCollection;
    this.repoConfigCollection = repoConfigCollection;
  }

  static async connect(uri: string): Promise<StateManager> {
    const client = new MongoClient(uri);
    await client.connect();
    const db = client.db();
    const collection = db.collection<JobState>("jobs");
    const logsCollection = db.collection<JobLogDoc>("job_logs");
    const repoConfigCollection = db.collection<RepoConfig>("repo_configs");

    // Create indexes
    await collection.createIndex(
      { owner: 1, repo: 1, issueNumber: 1 },
      { unique: true }
    );
    await collection.createIndex({ status: 1 });
    await collection.createIndex({ prUrl: 1 }, { sparse: true });
    await collection.createIndex({ branch: 1 }, { sparse: true });

    await logsCollection.createIndex({ jobId: 1 }, { unique: true });

    await repoConfigCollection.createIndex({ id: 1 }, { unique: true });

    log.info("Connected to MongoDB");
    return new StateManager(collection, logsCollection, repoConfigCollection);
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
        { status: { $nin: ["completed", "failed", "closed"] } },
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
}
