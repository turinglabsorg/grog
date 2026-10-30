import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, beforeEach, test } from 'node:test';
import { DiscordClient } from './discord-client.js';
import { DiscordThreads } from './discord-threads.js';
import { discordProject, findGrogFile, saveProjectDiscord } from './project-config.js';
import { installThreadHooks } from './thread-hooks.js';

const cli = join(dirname(fileURLToPath(import.meta.url)), 'index.js');
const root = mkdtempSync(join(tmpdir(), 'grog-thread-test-'));
const home = join(root, 'user');
const project = join(root, 'project');
let server, api, requests, channels, messages, nextId, forbidCreate;
const env = session => ({ PATH: process.env.PATH, HOME: home, CODEX_THREAD_ID: session, GROG_THREAD_LISTENER: '0', GROG_DISCORD_API: api, TMUX: '', TMUX_PANE: '' });
const bridge = (session = 'session-a', cwd = project) => new DiscordThreads({ client: new DiscordClient({ token: 'test-token', apiBase: api }), home, cwd, env: env(session) });

before(async () => {
  mkdirSync(join(home, '.grog'), { recursive: true });
  writeFileSync(join(home, '.grog', 'config.json'), JSON.stringify({ discordBotToken: 'test-token' }));
  server = http.createServer(async (req, res) => {
    let raw = '';for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : null;
    const url = new URL(req.url, 'http://localhost');
    requests.push({ method: req.method, path: url.pathname, query: url.search, body });
    let data, status = 200;
    if (url.pathname === '/users/@me') data = { id: '9', username: 'Test bot' };
    else if (url.pathname === '/channels/10/threads' && req.method === 'POST') {
      if (forbidCreate) { status = 403;data = { message: 'denied' }; }
      else {
        const id = String(++nextId);
        data = { id, name: body.name, parent_id: '10', guild_id: '1', type: body.type, thread_metadata: { archived: false } };
        channels.set(id, data);messages.set(id, []);
      }
    } else {
      const match = url.pathname.match(/^\/channels\/(\d+)(.*)$/);
      if (match && channels.has(match[1])) {
        const channel = channels.get(match[1]);
        if (match[2] === '/thread-members/@me') { status = 204;data = null; }
        else if (match[2] === '/messages') {
          if (req.method === 'POST') {
            data = { id: String(++nextId), author: { id: '9', bot: true }, content: body.content };
            messages.get(match[1]).push(data);
          } else data = (messages.get(match[1]) || []).filter(m => BigInt(m.id) > BigInt(url.searchParams.get('after') || '0')).sort((a,b)=>BigInt(a.id)<BigInt(b.id)?-1:1).slice(0, Number(url.searchParams.get('limit') || 50));
        } else if (req.method === 'PATCH') { Object.assign(channel, body);if ('archived' in body) channel.thread_metadata.archived = body.archived;data = channel; }
        else data = channel;
      } else { status = 404;data = { message: 'missing' }; }
    }
    res.writeHead(status, { 'content-type': 'application/json' });res.end(data === null ? '' : JSON.stringify(data));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  api = `http://127.0.0.1:${server.address().port}`;
});
beforeEach(() => {
  requests = [];channels = new Map([['10', { id: '10', type: 0, guild_id: '1' }]]);messages = new Map([['10', []]]);nextId = 100;forbidCreate = false;
  rmSync(join(home, '.grog', 'discord-sessions'), { force: true, recursive: true });
  mkdirSync(project, { recursive: true });mkdirSync(join(project, '.git'), { recursive: true });
  writeFileSync(join(project, '.grog'), '# Keep my project\nworkspace=CLIENT\nnotion=CLIENT\ndiscordServer=1\ndiscordChannel=10\n');
});
after(async () => { await new Promise(resolve => server.close(resolve));rmSync(root, { force: true, recursive: true }); });

function run(executable, args, session = 'session-a', input = '', cwd = project, overrides = {}) {
  return new Promise(resolve => {
    const child = spawn(executable, args, { cwd, env: { ...env(session), ...overrides }, stdio: ['pipe','pipe','pipe'] });
    let out = '', err = '';child.stdout.on('data', b => out += b);child.stderr.on('data', b => err += b);
    child.stdin.end(input);child.on('close', code => resolve({ code, out, err }));
  });
}

function command(args, ...options) {
  return run(process.execPath, [cli, ...args], ...options);
}

test('the shared .grog preserves Linear, Notion and comments when Discord is configured', () => {
  saveProjectDiscord(project, '2', '20');
  const text = readFileSync(join(project, '.grog'), 'utf8');
  assert.match(text, /workspace=CLIENT/);assert.match(text, /notion=CLIENT/);assert.match(text, /# Keep my project/);
  assert.equal(discordProject(project).guildId, '2');assert.equal(discordProject(project).channelId, '20');
});
test('missing or partial project Discord asks for configuration and never uses another project', () => {
  const nested = join(project, 'nested');mkdirSync(join(nested, '.git'), { recursive: true });
  assert.equal(findGrogFile(nested), null);assert.throws(()=>discordProject(nested,true), /Ask the user/);
  writeFileSync(join(project, '.grog'), 'workspace=CLIENT\ndiscordServer=1\n');assert.throws(()=>discordProject(project), /not configured/);
});
test('configuration CLI verifies channel belongs to the server before changing .grog', async () => {
  const before = readFileSync(join(project,'.grog'),'utf8');
  const bad = await command(['discord-config','--server','2','--channel','10']);assert.equal(bad.code,1);
  assert.equal(readFileSync(join(project,'.grog'),'utf8'),before);
  const good = await command(['discord-config','--server','1','--channel','10']);assert.equal(good.code,0,good.err);
  assert.match(readFileSync(join(project,'.grog'),'utf8'),/workspace=CLIENT/);
});
test('thread names are exact session summaries or issue numbers and repeated open resumes', async () => {
  const session = bridge();const first = await session.open('Checkout flow');
  assert.equal(first.title,'Checkout flow');assert.equal(channels.get(first.threadId).name,'Checkout flow');
  const resumed = await session.open('Checkout flow');assert.equal(resumed.threadId,first.threadId);
  const issue = await session.open('MTR-123');assert.equal(issue.title,'MTR-123');assert.notEqual(issue.threadId,first.threadId);
  assert.equal(requests.filter(r=>r.method==='POST'&&r.path.endsWith('/threads')).length,2);
  assert.equal((await session.open('Checkout flow')).threadId,first.threadId);
});
test('two sessions on the same issue keep independent threads and inboxes', async () => {
  const a=bridge('a'),b=bridge('b');const one=await a.open('MTR-123'),two=await b.open('MTR-123');
  assert.notEqual(one.threadId,two.threadId);
  messages.get(one.threadId).push({id:'500',author:{username:'Owner'},content:'A only'});
  messages.get(two.threadId).push({id:'501',author:{username:'Owner'},content:'B only'});
  assert.deepEqual((await a.inbox()).map(m=>m.content),['A only']);assert.deepEqual((await b.inbox()).map(m=>m.content),['B only']);
  await a.acknowledge('500');assert.equal((await a.inbox()).length,0);assert.equal((await b.inbox()).length,1);
  await assert.rejects(b.acknowledge('500'),/does not match/);
});
test('send automatically routes to this session thread instead of the global channel', async () => {
  const one=await bridge().open('Session title');
  const result=await command(['send','--discord','Hello from my work']);assert.equal(result.code,0,result.err);
  const sent=requests.find(r=>r.method==='POST'&&r.path.endsWith('/messages'));
  assert.equal(sent.path,`/channels/${one.threadId}/messages`);assert.equal(sent.body.content,'Hello from my work');
});
test('resuming an archived thread reopens it; locked or foreign threads are refused', async () => {
  const session=bridge();const one=await session.open('Session title');channels.get(one.threadId).thread_metadata.archived=true;
  assert.equal((await session.open('Session title')).threadId,one.threadId);assert.equal(channels.get(one.threadId).thread_metadata.archived,false);
  channels.get(one.threadId).thread_metadata.locked=true;await assert.rejects(session.open('Session title'),/locked/);
  channels.get(one.threadId).guild_id='other';await assert.rejects(session.open('Session title'),/does not belong/);
});
test('a permission refusal cannot leave a phantom binding or create a second thread', async () => {
  forbidCreate=true;await assert.rejects(bridge().open('Session title'),/denied/);
  forbidCreate=false;await bridge().open('Session title');assert.equal(channels.size,2);
});
test('reconnection replays no acknowledged messages and filters bot notifications', async () => {
  const one=await bridge().open('Session title');
  messages.get(one.threadId).push({id:'300',author:{username:'bot',bot:true},content:'ignore'}, {id:'301',author:{username:'Owner'},content:'continue'});
  const pending=await bridge().inbox();assert.equal(pending.length,1);assert.equal(pending[0].id,'301');
  assert.equal((await bridge().inbox()).length,1);await bridge().acknowledge('301');assert.equal((await bridge().inbox()).length,0);
});
test('hook delivery reaches only the bound session and acknowledges only delivered messages', async () => {
  const session=bridge();const one=await session.open('Session title');
  messages.get(one.threadId).push({id:'300',author:{username:'Owner'},content:'How are we doing?'});await session.sync();
  const other=await command(['thread-hook','--codex'],'other',JSON.stringify({cwd:project,session_id:'other',hook_event_name:'PostToolUse'}));assert.deepEqual(JSON.parse(other.out),{});
  const delivered=await command(['thread-hook','--codex'],'session-a',JSON.stringify({cwd:project,session_id:'session-a',hook_event_name:'PostToolUse'}));
  assert.equal(delivered.code,0,delivered.err);const output=JSON.parse(delivered.out);
  assert.match(output.hookSpecificOutput.additionalContext,/How are we doing/);assert.equal(output.hookSpecificOutput.hookEventName,'PostToolUse');assert.equal((await session.inbox()).length,0);
});
test('Stop hook continues with a real pending message but never invents a continuation', async () => {
  const session=bridge();const one=await session.open('Session title');
  const packet=JSON.stringify({cwd:project,session_id:'session-a',hook_event_name:'Stop'});
  assert.deepEqual(JSON.parse((await command(['thread-hook','--codex'],'session-a',packet)).out),{});
  messages.get(one.threadId).push({id:'300',author:{username:'Owner'},content:'Keep changes in this module'});await session.sync();
  const output=JSON.parse((await command(['thread-hook','--codex'],'session-a',packet)).out);assert.equal(output.decision,'block');assert.match(output.reason,/Keep changes/);
});
test('hook installation preserves unrelated settings and is idempotent for both runtimes', () => {
  mkdirSync(join(home,'.claude'),{recursive:true});mkdirSync(join(home,'.codex'),{recursive:true});
  const file=join(home,'.codex','hooks.json');writeFileSync(file,JSON.stringify({description:'keep',hooks:{PreToolUse:[{hooks:[{type:'command',command:'existing policy'}]}]}}));
  const settings=join(home,'.claude','settings.json');writeFileSync(settings,JSON.stringify({permissions:{allow:['Read']},hooks:{PreToolUse:[{matcher:'Bash',hooks:[{type:'command',command:'existing Claude policy'},{type:'command',command:'legacy-node /legacy/grog.js thread-hook --claude'}]}]}}));
  installThreadHooks(home,cli);installThreadHooks(home,cli);
  assert.equal(JSON.parse(readFileSync(file)).hooks.PreToolUse.length,2);assert.equal(JSON.parse(readFileSync(file)).description,'keep');assert.deepEqual(JSON.parse(readFileSync(settings)).permissions,{allow:['Read']});
  assert.equal(JSON.parse(readFileSync(settings)).hooks.PreToolUse[0].hooks[0].command,'existing Claude policy');
  for (const [provider, path] of [['codex', file], ['claude', settings]]) {
    for (const groups of Object.values(JSON.parse(readFileSync(path)).hooks)) {
      const handlers = groups.flatMap(group => group.hooks).filter(hook => hook.command.includes(`thread-hook --${provider}`));
      assert.equal(handlers.length, 1, `${provider} hook installed more than once`);
    }
  }
});

for (const bridged of [false, true]) {
  test(`installed Claude hooks deliver and disconnect through ${bridged ? 'Scott with host session identity' : 'the native runtime'}`, async () => {
    const host = { CODEX_THREAD_ID: '', TMUX: '/tmp/claude-hooks,1,0', TMUX_PANE: '%43' };
    const session = new DiscordThreads({client: new DiscordClient({token: 'test-token', apiBase: api}), home, cwd: project, env: {...env(''), ...host}});
    const opened = await session.open('Claude hook regression');
    const bin = join(root, 'hook bin');mkdirSync(bin, {recursive: true});
    const quote = value => "'" + value.replace(/'/g, "'\\''") + "'";
    const incompatibleNode = join(bin, 'macOS-node');
    writeFileSync(incompatibleNode, '#!/bin/sh\necho "Exec format error: host Node must not run in the container" >&2\nexit 126\n', {mode: 0o755});
    writeFileSync(join(bin, 'grog'), `#!/bin/sh\nexport TMUX=${quote(host.TMUX)} TMUX_PANE=${quote(host.TMUX_PANE)}\nexec ${quote(process.execPath)} ${quote(cli)} "$@"\n`, {mode: 0o755});
    installThreadHooks(home, cli, bridged ? incompatibleNode : process.execPath);
    const hooks = JSON.parse(readFileSync(join(home, '.claude', 'settings.json'))).hooks;
    const overrides = {...host, PATH: bin + ':' + process.env.PATH, SCOTT_BRIDGE: ''};
    if (bridged) Object.assign(overrides, {SCOTT_BRIDGE: 'fixture', TMUX: '', TMUX_PANE: ''});
    let id = 700;
    for (const event of ['PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'Stop', 'SessionEnd']) {
      if (event !== 'SessionEnd') {
        messages.get(opened.threadId).push({id: String(++id), author: {username: 'Owner'}, content: `Message for ${event}`});
        await session.sync();
      }
      const handler = hooks[event].flatMap(group => group.hooks).find(hook => hook.command.includes('thread-hook --claude'));
      const result = await run('sh', ['-c', handler.command], '', JSON.stringify({cwd: project, session_id: 'claude-native-id', hook_event_name: event}), project, overrides);
      assert.equal(result.code, 0, result.err);assert.equal(result.err, '');
      const output = JSON.parse(result.out);
      if (event === 'SessionEnd') {
        assert.deepEqual(output, {});assert.equal(session.binding(), null);
      } else {
        if (event === 'Stop') {assert.equal(output.decision, 'block');assert.match(output.reason, /Message for Stop/);}
        else {assert.equal(output.hookSpecificOutput.hookEventName, event);assert.ok(output.hookSpecificOutput.additionalContext.includes(`Message for ${event}`));}
        assert.equal(session.binding(true).inbox.length, 0);
        assert.equal(session.binding(true).lastHandoff.event, event);
        assert.equal(session.binding(true).lastHandoff.provider, 'claude');
      }
    }
  });
}

test('a stale in-flight sync cannot replay a message acknowledged by another call', async () => {
  const session=bridge();const opened=await session.open('Session title');
  messages.get(opened.threadId).push({id:'600',author:{username:'Owner'},content:'Only once'});
  await session.sync();await session.acknowledge('600');await session.sync(opened);
  assert.deepEqual(await session.inbox(),[]);
});
test('concurrent hooks hand off each inbox message once', async () => {
  const session=bridge();const opened=await session.open('Session title');
  messages.get(opened.threadId).push({id:'600',author:{username:'Owner'},content:'One consumer'});await session.sync();
  let deliveries=0;await Promise.all([session.deliver(()=>deliveries++),session.deliver(()=>deliveries++)]);
  assert.equal(deliveries,1);assert.deepEqual(await session.inbox(),[]);
});
test('ambiguous creation is refused on retry instead of opening a duplicate thread', async () => {
  const session=bridge();const realCreate=session.client.createThread.bind(session.client);
  session.client.createThread=async (...args)=>{await realCreate(...args);throw new Error('Connection lost after creation')};
  await assert.rejects(session.open('Session title'),/Connection lost/);
  session.client.createThread=realCreate;await assert.rejects(session.open('Session title'),/unconfirmed/);
  assert.equal(requests.filter(r=>r.method==='POST'&&r.path.endsWith('/threads')).length,1);
});

test('tmux-name automatically opens a Linear identifier thread and routes this session', async () => {
  const bin=join(root,'bin');mkdirSync(bin,{recursive:true});const log=join(root,'tmux-args');
  writeFileSync(join(bin,'tmux'), `#!/bin/sh\nprintf '%s\\n' "$@" > "${log}"\n`);chmodSync(join(bin,'tmux'),0o755);
  const result=await command(['tmux-name','https://linear.app/example/issue/PROJ-123/title'],'session-a','',project,
    {PATH:bin+':'+process.env.PATH,TMUX:'/tmp/test-socket,1,0',TMUX_PANE:'%999'});
  assert.equal(result.code,0,result.err);assert.match(result.out,/Discord thread/);
  assert.deepEqual(readFileSync(log,'utf8').trim().split('\n'),['rename-window','-t','%999','PROJ-123']);
  assert.equal(bridge().binding(true).title,'PROJ-123');
});
test('Claude hook uses its own tmux binding and delivers pending input', async () => {
  const overrides={CODEX_THREAD_ID:'',TMUX:'/tmp/claude-test,1,0',TMUX_PANE:'%42'};
  const session=new DiscordThreads({client:new DiscordClient({token:'test-token',apiBase:api}),home,cwd:project,env:{...env(''),...overrides}});
  const opened=await session.open('Claude session summary');
  messages.get(opened.threadId).push({id:'700',author:{username:'Owner'},content:'Claude-specific reply'});await session.sync();
  const result=await command(['thread-hook','--claude'],'',JSON.stringify({cwd:project,hook_event_name:'PostToolUse',session_id:'claude-native-id'}),project,overrides);
  assert.equal(result.code,0,result.err);assert.match(JSON.parse(result.out).hookSpecificOutput.additionalContext,/Claude-specific reply/);
  assert.equal((await session.inbox()).length,0);
});

test('Codex hooks in the workspace root find the active nested project without crossing projects', async () => {
  const session=bridge();const opened=await session.open('Nested project');
  messages.get(opened.threadId).push({id:'800',author:{username:'Owner'},content:'Nested reply'});await session.sync();
  const input=JSON.stringify({cwd:root,session_id:'session-a',hook_event_name:'PostToolUse'});
  const result=await command(['thread-hook','--codex'],'session-a',input,root);
  assert.match(JSON.parse(result.out).hookSpecificOutput.additionalContext,/Nested reply/);
  const foreign=join(root,'other-project');mkdirSync(foreign,{recursive:true});mkdirSync(join(foreign,'.git'),{recursive:true});
  messages.get(opened.threadId).push({id:'801',author:{username:'Owner'},content:'Private to nested project'});await session.sync();
  const denied=await command(['thread-hook','--codex'],'session-a',JSON.stringify({cwd:foreign,session_id:'session-a',hook_event_name:'PostToolUse'}),foreign);
  assert.deepEqual(JSON.parse(denied.out),{});assert.equal((await session.inbox()).length,1);
});

test('generic send in a bound project uses Discord automatically', async () => {
  const opened=await bridge().open('Session title');
  const result=await command(['send','Automatic transport']);assert.equal(result.code,0,result.err);
  assert.equal(requests.find(r=>r.method==='POST'&&r.path.endsWith('/messages')).path,`/channels/${opened.threadId}/messages`);
});
test('the active nested project remains the target from its parent workspace', async () => {
  const opened=await bridge().open('Nested session');
  const result=await command(['send','From workspace'],'session-a','',root);assert.equal(result.code,0,result.err);
  assert.equal(requests.find(r=>r.method==='POST'&&r.path.endsWith('/messages')).path,`/channels/${opened.threadId}/messages`);
});

test('a failed join retains the known thread for a safe retry', async () => {
  const session=bridge();const join=session.client.joinThread.bind(session.client);
  session.client.joinThread=async ()=>{throw new Error('Join failed')};
  await assert.rejects(session.open('Session title'),/Join failed/);session.client.joinThread=join;
  await session.open('Session title');assert.equal(requests.filter(r=>r.method==='POST'&&r.path.endsWith('/threads')).length,1);
});
