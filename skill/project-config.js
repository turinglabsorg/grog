import { existsSync, readFileSync, realpathSync, statSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export function findGrogFile(startDir) {
  let directory = realpathSync(startDir);
  while (true) {
    const file = join(directory, '.grog');
    if (existsSync(file) && statSync(file).isFile()) return file;
    if (existsSync(join(directory, '.git'))) return null;
    const parent = dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

export function projectConfig(cwd = process.cwd()) {
  const file = findGrogFile(cwd);
  if (!file) return { file: null, values: {} };
  const values = {};
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    if (Object.hasOwn(values, match[1]) && /^discord/.test(match[1])) throw new Error(`Duplicate ${match[1]} in .grog`);
    values[match[1]] = match[2];
  }
  return { file, values };
}

export function discordProject(cwd = process.cwd(), required = false) {
  const config = projectConfig(cwd);
  const guildId = config.values.discordServer;
  const channelId = config.values.discordChannel;
  if (!guildId && !channelId && !required) return null;
  if (!/^\d{1,22}$/.test(guildId || '') || !/^\d{1,22}$/.test(channelId || '')) {
    throw new Error('Project Discord is not configured. Ask the user for the server and channel, then run grog discord-config --server ID --channel ID.');
  }
  return { file: config.file, root: dirname(config.file), guildId, channelId };
}

export function saveProjectDiscord(cwd, guildId, channelId) {
  if (!/^\d{1,22}$/.test(guildId) || !/^\d{1,22}$/.test(channelId)) throw new Error('Server and channel must be Discord IDs');
  const current = projectConfig(cwd);
  const file = current.file || join(resolve(cwd), '.grog');
  let content = current.file ? readFileSync(file, 'utf8') : '';
  for (const [key, value] of Object.entries({ discordServer: guildId, discordChannel: channelId })) {
    const pattern = new RegExp('^\\s*' + key + '\\s*=.*$', 'm');
    if (pattern.test(content)) content = content.replace(pattern, `${key}=${value}`);
    else content = content.replace(/\s*$/, '\n') + `${key}=${value}\n`;
  }
  const temporary = file + '.' + process.pid + '.tmp';
  writeFileSync(temporary, content, { mode: 0o600, flag: 'wx' });
  renameSync(temporary, file);
  return file;
}
