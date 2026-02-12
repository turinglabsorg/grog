import { MongoClient, Collection } from "mongodb";
import type { JobState } from "./types.js";
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

  private constructor(
    collection: Collection<JobState>,
    logsCollection: Collection<JobLogDoc>
  ) {
    this.collection = collection;
    this.logsCollection = logsCollection;
  }

  static async connect(uri: string): Promise<StateManager> {
    const client = new MongoClient(uri);
    await client.connect();
    const db = client.db();
    const collection = db.collection<JobState>("jobs");
    const logsCollection = db.collection<JobLogDoc>("job_logs");

    // Create indexes
    await collection.createIndex(
      { owner: 1, repo: 1, issueNumber: 1 },
      { unique: true }
    );
    await collection.createIndex({ status: 1 });
    await collection.createIndex({ prUrl: 1 }, { sparse: true });
    await collection.createIndex({ branch: 1 }, { sparse: true });

    await logsCollection.createIndex({ jobId: 1 }, { unique: true });

    log.info("Connected to MongoDB");
    return new StateManager(collection, logsCollection);
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
}
