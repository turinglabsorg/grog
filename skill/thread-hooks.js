import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';

const quote = value => "'" + value.replace(/'/g, "'\\''") + "'";

export function installThreadHooks(home, cli, node = process.execPath) {
  const pending = [];
  for (const [provider, file] of [['codex', join(home, '.codex', 'hooks.json')], ['claude', join(home, '.claude', 'settings.json')]]) {
    const original = existsSync(file) ? readFileSync(file, 'utf8') : null;
    const settings = original ? JSON.parse(original) : {};
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('Invalid agent hook configuration');
    settings.hooks ||= {};
    for (const event of ['PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'Stop', 'SessionEnd']) {
      const groups = settings.hooks[event] || [];
      if (!Array.isArray(groups)) throw new Error('Invalid agent hook event configuration');
      // Remove only previous Grog thread handlers, preserving every unrelated hook.
      settings.hooks[event] = groups.map(group => ({ ...group, hooks: group.hooks.filter(hook => !/thread-hook --(?:codex|claude)(?:\s|$)/.test(hook.command || '')) })).filter(group => group.hooks.length);
      settings.hooks[event].push({ hooks: [{ type: 'command', command: `${quote(node)} ${quote(cli)} thread-hook --${provider}`, timeout: event === 'SessionEnd' ? 3 : 5 }] });
    }
    pending.push({ file, original, content: JSON.stringify(settings, null, 2) + '\n' });
  }
  const applied = [];
  try {
    for (const entry of pending) {
      mkdirSync(dirname(entry.file), { recursive: true });
      const temporary = entry.file + '.' + process.pid + '.tmp';
      writeFileSync(temporary, entry.content, { mode: 0o600, flag: 'wx' });
      renameSync(temporary, entry.file);
      applied.push(entry);
    }
  } catch (error) {
    for (const entry of applied.reverse()) {
      if (entry.original === null) unlinkSync(entry.file);
      else writeFileSync(entry.file, entry.original, { mode: 0o600 });
    }
    throw error;
  }
}
