import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { discordProject } from './project-config.js';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const hash = value => createHash('sha256').update(value).digest('hex');

function read(file, fallback) {
  try { return JSON.parse(readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw new Error('Invalid Discord session state'); }
}
function save(file, data) {
  const temporary = file + '.' + randomUUID() + '.tmp';
  writeFileSync(temporary, JSON.stringify(data) + '\n', { mode: 0o600, flag: 'wx' });
  renameSync(temporary, file);
}
async function locked(file, action) {
  const lock = file + '.lock';
  let descriptor;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { descriptor = openSync(lock, 'wx', 0o600); writeFileSync(descriptor, String(process.pid)); break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        if (statSync(lock).mtimeMs < Date.now() - 60000) {
          const pid = Number(readFileSync(lock, 'utf8'));
          if (pid > 1) {
            try { process.kill(pid, 0); } catch (probe) { if (probe.code === 'ESRCH') { try { unlinkSync(lock); } catch {} } }
          }
        }
      } catch (probe) { if (probe.code !== 'ENOENT') throw probe; }
      await delay(50);
    }
  }
  if (descriptor === undefined) throw new Error('Discord session is busy; retry shortly');
  try { return await action(); } finally { closeSync(descriptor); unlinkSync(lock); }
}

export class DiscordThreads {
  constructor({ client, cwd = process.cwd(), env = process.env, home = homedir(), daemon = () => false }) {
    Object.assign(this, { client, cwd, env, home, daemon });
  }
  context(required = false) {
    const project = discordProject(this.cwd, required);
    if (!project) return null;
    if (!this.env.CODEX_THREAD_ID && this.daemon()) throw new Error('Shared Codex daemon cannot safely identify this tmux session; use Codex without the shared daemon.');
    const identity = this.env.CODEX_THREAD_ID || this.env.GROG_SESSION_ID || (this.env.TMUX && this.env.TMUX_PANE ? this.env.TMUX.split(',')[0] + ':' + this.env.TMUX_PANE : null);
    if (!identity) { if (required) throw new Error('No agent session: run inside the Codex/Claude tmux pane'); return null; }
    const key = hash(project.file + '\0' + identity);
    const directory = join(this.home, '.grog', 'discord-sessions');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    return { ...project, key, directory, file: join(directory, key + '.json') };
  }
  hookProject() {
    if (discordProject(this.cwd)) return this;
    const identity = this.env.CODEX_THREAD_ID || this.env.GROG_SESSION_ID;
    if (!identity) return this;
    const marker = read(join(this.home, '.grog', 'discord-sessions', hash(identity) + '.active.json'), null);
    if (!marker?.root) return this;
    const path = relative(realpathSync(this.cwd), marker.root);
    if (isAbsolute(path) || path === '..' || path.startsWith('../')) return this;
    return new DiscordThreads({ client: this.client, cwd: marker.root, env: this.env, home: this.home, daemon: this.daemon });
  }
  binding(required = false) {
    const context = this.context(required);
    if (!context) return null;
    const state = read(context.file, { threads: {} });
    const binding = state.threads?.[state.current];
    if (binding && binding.guildId === context.guildId && binding.parentId === context.channelId) return { ...binding, context };
    if (required) throw new Error('No thread for this session. Run grog tmux-name ISSUE or grog thread open NAME.');
    return null;
  }
  ownerPid() {
    let pid = process.ppid;
    for (let depth = 0; pid > 1 && depth < 16; depth++) {
      try {
        const text = execFileSync('ps', ['-o', 'ppid=,comm=', '-p', String(pid)], { encoding: 'utf8' }).trim();
        const match = text.match(/^(\d+)\s+(.*)$/s);
        if (!match) break;
        if (/(?:^|\/)(?:codex|claude)$/.test(match[2])) return pid;
        pid = Number(match[1]);
      } catch { break; }
    }
    return null;
  }
  async open(issue) {
    const context = this.context(true);
    const name = String(issue).trim().replace(/[\x00-\x1f\x7f]/g, '').slice(0, 70);
    if (!name) throw new Error('A thread needs an issue identifier or name');
    return locked(context.file, async () => {
      const parent = await this.client.getChannel(context.channelId);
      if (parent.guild_id !== context.guildId || parent.type !== 0) throw new Error('Configured Discord channel must be a text channel in the configured server');
      const state = read(context.file, { threads: {} });
      const key = context.guildId + '/' + context.channelId + '/' + name;
      let binding = state.threads[key];
      const title = name;
      let thread;
      if (binding?.threadId) {
        thread = await this.client.getChannel(binding.threadId);
      } else {
        if (binding?.creating) {
          throw new Error('Previous thread creation is unconfirmed. Inspect Discord before reconnecting; no duplicate was created.');
        } else {
          binding = { issue: name, guildId: context.guildId, parentId: context.channelId, creating: true };
          state.threads[key] = binding;
          save(context.file, state);
          try { thread = await this.client.createThread(context.channelId, title); }
          catch (error) {
            if (error.status >= 400 && error.status < 500 && error.status !== 429) { delete state.threads[key]; save(context.file, state); }
            throw error;
          }
        }
      }
      if (thread.parent_id !== context.channelId || thread.guild_id !== context.guildId || thread.type !== 11) throw new Error('Thread does not belong to this project channel');
      if (thread.thread_metadata?.locked) throw new Error('Thread is locked; ask its administrator to reopen it');
      state.threads[key] = { ...binding, threadId: thread.id, creating: false };
      save(context.file, state);
      if (thread.name !== title) await this.client.updateThread(thread.id, { name: title });
      if (thread.thread_metadata?.archived) await this.client.updateThread(thread.id, { archived: false });
      await this.client.joinThread(thread.id);
      binding = { ...binding, issue: name, title, threadId: thread.id, guildId: context.guildId, parentId: context.channelId, creating: false, cursor: binding?.cursor || '0', acknowledged: binding?.acknowledged || '0', inbox: binding?.inbox || [], ownerPid: this.ownerPid() };
      state.threads[key] = binding;
      state.current = key;
      save(context.file, state);
      const identity = this.env.CODEX_THREAD_ID || this.env.GROG_SESSION_ID;
      if (identity) save(join(context.directory, hash(identity) + '.active.json'), { root: context.root });
      return { ...binding, context };
    });
  }
  async sync(binding = this.binding(true)) {
    // Fetch outside the state lock; merge by message id before advancing the cursor.
    let cursor = binding.cursor;
    const messages = [];
    for (let page = 0; page < 10; page++) {
      const rows = await this.client.listMessages(binding.threadId, { after: cursor, limit: 100 });
      if (!rows.length) break;
      messages.push(...rows);
      const next = rows.reduce((max, row) => BigInt(row.id) > BigInt(max) ? row.id : max, cursor);
      if (next === cursor) break;
      cursor = next;
      if (rows.length < 100) break;
    }
    await locked(binding.context.file, async () => {
      const state = read(binding.context.file, {});
      const entry = state.threads?.[state.current];
      if (entry?.threadId !== binding.threadId) return;
      const all = new Map((entry.inbox || []).map(m => [m.id, m]));
      for (const message of messages) if (!message.author?.bot && !message.webhook_id && BigInt(message.id) > BigInt(entry.acknowledged || '0')) all.set(message.id, {
        id: message.id, author: message.author?.global_name || message.author?.username || message.author?.id,
        content: message.content || '', attachments: message.attachments || [], timestamp: message.timestamp,
      });
      if (all.size > 1000) throw new Error('Thread inbox is full; consume pending messages before receiving more');
      entry.inbox = [...all.values()].sort((a, b) => BigInt(a.id) < BigInt(b.id) ? -1 : 1);
      if (BigInt(cursor) > BigInt(entry.cursor)) entry.cursor = cursor;
      save(binding.context.file, state);
    });
    return this.binding(true);
  }
  async inbox(ack) {
    const binding = await this.sync();
    if (ack) return this.acknowledge(ack, binding);
    return binding.inbox;
  }
  async acknowledge(ack, binding = this.binding(true)) {
      return locked(binding.context.file, async () => {
        const state = read(binding.context.file, {});
        const entry = state.threads?.[state.current];
        if (entry?.threadId !== binding.threadId || !entry.inbox.some(m => m.id === ack)) throw new Error('Acknowledgement does not match a pending message in this session');
        entry.inbox = entry.inbox.filter(m => BigInt(m.id) > BigInt(ack));
        entry.acknowledged = ack;
        save(binding.context.file, state);
        return [];
      });
  }
  async deliver(consumer, metadata = {}) {
    const binding = this.binding(true);
    return locked(binding.context.file, async () => {
      const state = read(binding.context.file, {});
      const entry = state.threads?.[state.current];
      if (entry?.threadId !== binding.threadId || !entry.inbox.length) return false;
      const messages = entry.inbox.slice(0, 5);
      consumer(messages);
      entry.lastHandoff = { at: new Date().toISOString(), event: metadata.event || null, provider: metadata.provider || null };
      entry.acknowledged = messages.at(-1).id;
      entry.inbox = entry.inbox.slice(messages.length);
      save(binding.context.file, state);
      return true;
    });
  }
  async close() {
    const binding = this.binding(true);
    await locked(binding.context.file, async () => {
      const state = read(binding.context.file, {});
      if (state.threads?.[state.current]?.threadId === binding.threadId) { state.current = null; save(binding.context.file, state); }
    });
  }
  startListener(cli) {
    const binding = this.binding(true);
    if (this.env.GROG_THREAD_LISTENER === '0') return binding;
    const child = spawn(process.execPath, [cli, 'thread', 'listen'], { cwd: this.cwd, env: this.env, detached: true, stdio: 'ignore' });
    child.unref();
    return binding;
  }
  async listen() {
    const binding = this.binding(true);
    const lock = join(binding.context.directory, hash(binding.threadId + binding.context.key) + '.listener');
    if (existsSync(lock)) {
      const pid = Number(read(join(lock, 'owner.json'), {}).pid);
      if (pid > 1) { try { process.kill(pid, 0); return; } catch (error) { if (error.code !== 'ESRCH') return; } }
      else return;
      try { unlinkSync(join(lock, 'owner.json')); rmdirSync(lock); } catch { return; }
    }
    try { mkdirSync(lock, { mode: 0o700 }); } catch (error) { if (error.code === 'EEXIST') return; throw error; }
    save(join(lock, 'owner.json'), { pid: process.pid });
    try {
      let failures = 0;
      while (true) {
        const active = this.binding();
        if (!active || active.threadId !== binding.threadId) break;
        if (active.ownerPid) { try { process.kill(active.ownerPid, 0); } catch (error) { if (error.code === 'ESRCH') break; } }
        try { await this.sync(active); failures = 0; } catch { failures++; }
        await delay(Math.min(30000, 3000 * (failures + 1)));
      }
    } finally { unlinkSync(join(lock, 'owner.json')); rmdirSync(lock); }
  }
}
