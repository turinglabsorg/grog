export interface OutputLine {
  ts: number;
  type: "text" | "tool" | "error" | "status" | "user";
  content: string;
}

interface JobOutput {
  lines: OutputLine[];
  listeners: Set<(line: OutputLine) => void>;
}

const MAX_LINES = 500;
const store = new Map<string, JobOutput>();

function getOrCreate(jobId: string): JobOutput {
  let entry = store.get(jobId);
  if (!entry) {
    entry = { lines: [], listeners: new Set() };
    store.set(jobId, entry);
  }
  return entry;
}

export function pushLine(jobId: string, line: OutputLine): void {
  const entry = getOrCreate(jobId);
  entry.lines.push(line);
  if (entry.lines.length > MAX_LINES) {
    entry.lines.shift();
  }
  for (const cb of entry.listeners) {
    cb(line);
  }
}

export function subscribe(
  jobId: string,
  cb: (line: OutputLine) => void
): () => void {
  const entry = getOrCreate(jobId);
  entry.listeners.add(cb);
  return () => {
    entry.listeners.delete(cb);
  };
}

export function getBuffer(jobId: string): OutputLine[] {
  return store.get(jobId)?.lines ?? [];
}

export function cleanup(jobId: string): void {
  store.delete(jobId);
}
