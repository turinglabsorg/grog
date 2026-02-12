// --- GitHub Webhook Payload Types ---

export interface WebhookPayload {
  action: string;
  issue: Issue;
  comment: Comment;
  repository: Repository;
  sender: User;
}

export interface Issue {
  number: number;
  title: string;
  body: string | null;
  state: string;
  labels: Label[];
  user: User;
  html_url: string;
  created_at: string;
  updated_at: string;
  pull_request?: { html_url: string };
}

export interface Comment {
  id: number;
  body: string;
  user: User;
  created_at: string;
  html_url: string;
}

export interface Repository {
  full_name: string;
  clone_url: string;
  default_branch: string;
  owner: { login: string };
  name: string;
}

export interface Label {
  name: string;
  color: string;
}

export interface User {
  login: string;
  id: number;
}

// --- Job State ---

export type JobStatus =
  | "queued"
  | "working"
  | "waiting_for_reply"
  | "pr_opened"
  | "completed"
  | "failed"
  | "closed";

export interface JobState {
  id: string;
  owner: string;
  repo: string;
  issueNumber: number;
  status: JobStatus;
  branch: string;
  issueTitle?: string;
  tokenUsage?: { inputTokens: number; outputTokens: number };
  prUrl?: string;
  triggerCommentId: number;
  startedAt: string;
  updatedAt: string;
  retryCount?: number;
  failureReason?: string;
}

// --- Agent Result ---

export type AgentResultType = "pr_ready" | "needs_clarification" | "failed";

export interface AgentResult {
  type: AgentResultType;
  message: string;
  branch?: string;
}

// --- Job Queue ---

export interface QueuedJob {
  owner: string;
  repo: string;
  issueNumber: number;
  commentId: number;
  commentBody: string;
  defaultBranch: string;
}

// --- Config ---

export interface Config {
  ghToken: string;
  webhookSecret: string;
  botUsername: string;
  port: number;
  maxConcurrentJobs: number;
  workDir: string;
  mongodbUri: string;
  agentTimeoutMinutes: number;
  maxRetries: number;
  dailyTokenBudget: number;
  hourlyTokenBudget: number;
}

// --- Pull Request Webhook Payload ---

export interface PullRequestPayload {
  action: string;
  pull_request: {
    merged: boolean;
    merge_commit_sha: string | null;
    html_url: string;
    head: {
      ref: string;
      repo: {
        full_name: string;
        owner: { login: string };
        name: string;
      };
    };
    base: {
      ref: string;
    };
  };
  repository: Repository;
}
