import { createReadStream, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, statSync, writeSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { Unzip, UnzipInflate } from 'fflate';
import { Store, now } from './db.ts';
import { createBackup, serverIsRunning } from './backups.ts';
import { newUser, email, password, text } from './account-helpers.ts';
import { passwordFields } from './auth.ts';
import { Pages } from './pages.ts';
import { Events } from './events.ts';

/** Extract to a staging directory and validate everything before changing the active database. */
export async function restoreBackup(file: string, dataDir: string, force = false): Promise<void> {
  if (!force && serverIsRunning(dataDir)) throw new Error('The server is running. Stop it before restoring, or pass --force.');
  mkdirSync(dataDir, { recursive: true });
  const stage = mkdtempSync(join(dataDir, '.restore-'));
  const descriptors = new Set<number>();
  try {
    const entries = new Set<string>();
    let extractionError: Error | undefined;
    let manifestSize = 0;
    // Native backups are stored without compression. Permit compressed backups
    // while bounding expansion relative to input size, including unknown sizes.
    const maxExpanded = Math.max(400 * 1024 * 1024, statSync(file).size * 100);
    let declared = 0, expanded = 0;
    const unzip = new Unzip(entry => {
      const name = entry.name;
      if (!name || name.startsWith('/') || name.includes('\\') || name.split('/').some(part => part === '..' || part === '.') || entries.has(name)) throw new Error('Unsafe or duplicate path in backup archive.');
      if (!['cairn.db', 'manifest.json'].includes(name) && !name.startsWith('files/')) throw new Error('Unexpected file in backup archive.');
      declared += entry.originalSize ?? 0;
      if (declared > maxExpanded) throw new Error('Expanded archive is too large.');
      entries.add(name);
      const destination = join(stage, name);
      if (name.endsWith('/')) {
        mkdirSync(destination, { recursive: true });
        entry.ondata = (error, chunk) => {
          if (error) extractionError = error;
          else if (chunk.length) { extractionError = new Error('Directory entries must be empty.'); entry.terminate(); }
        };
        entry.start(); return;
      }
      mkdirSync(join(destination, '..'), { recursive: true });
      const fd = openSync(destination, 'wx', 0o600); descriptors.add(fd);
      let entrySize = 0;
      entry.ondata = (error, chunk, final) => {
        if (error) { extractionError = error; return; }
        if (extractionError) return;
        expanded += chunk.length; entrySize += chunk.length;
        if (expanded > maxExpanded || (entry.originalSize !== undefined && entrySize > entry.originalSize)) {
          extractionError = new Error('Expanded archive is too large or has inconsistent entry sizes.'); entry.terminate(); return;
        }
        if (name === 'manifest.json') manifestSize += chunk.length;
        if (manifestSize > 1024 * 1024) { extractionError = new Error('Backup manifest is too large.'); return; }
        writeSync(fd, chunk);
        if (final) { closeSync(fd); descriptors.delete(fd); }
      };
      entry.start();
    });
    unzip.register(UnzipInflate);
    for await (const chunk of createReadStream(file)) { unzip.push(new Uint8Array(chunk as Buffer), false); if (extractionError) throw extractionError; }
    unzip.push(new Uint8Array(), true);
    if (extractionError) throw extractionError;
    if (descriptors.size || !entries.has('cairn.db') || !entries.has('manifest.json')) throw new Error('Incomplete Cairn backup archive.');
    const manifest = JSON.parse(readFileSync(join(stage, 'manifest.json'), 'utf8'));
    if (typeof manifest.version !== 'string' || typeof manifest.createdAt !== 'string' || !manifest.counts || typeof manifest.counts !== 'object') throw new Error('Invalid Cairn backup manifest.');
    const candidate = join(stage, 'cairn.db');
    const db = new DatabaseSync(candidate, { readOnly: true });
    try {
      if (db.prepare('PRAGMA integrity_check').get()!.integrity_check !== 'ok') throw new Error('Backup database integrity check failed.');
      for (const table of ['users', 'workspaces', 'pages', 'files', 'settings']) db.prepare(`SELECT * FROM ${table} LIMIT 1`).get();
    } finally { db.close(); }
    // Check again after extraction, since a server could have started during validation.
    if (!force && serverIsRunning(dataDir)) throw new Error('The server started during restore. Stop it before restoring, or pass --force.');
    const current = join(dataDir, 'cairn.db'), previous = join(dataDir, 'cairn.db.before-restore');
    if (existsSync(current)) {
      const old = new DatabaseSync(current);
      try {
        const preserved = join(stage, 'previous.db');
        old.exec(`VACUUM INTO '${preserved.replaceAll("'", "''")}'`);
        rmSync(previous, { force: true }); renameSync(preserved, previous);
      } finally { old.close(); }
    }
    mkdirSync(join(stage, 'files'), { recursive: true });
    const oldFiles = join(dataDir, 'files.before-restore');
    rmSync(oldFiles, { recursive: true, force: true });
    if (existsSync(join(dataDir, 'files'))) renameSync(join(dataDir, 'files'), oldFiles);
    try {
      renameSync(join(stage, 'files'), join(dataDir, 'files'));
      rmSync(`${current}-wal`, { force: true }); rmSync(`${current}-shm`, { force: true });
      renameSync(candidate, current);
    } catch (error) {
      if (existsSync(oldFiles)) { rmSync(join(dataDir, 'files'), { recursive: true, force: true }); renameSync(oldFiles, join(dataDir, 'files')); }
      throw error;
    }
  } finally {
    for (const fd of descriptors) closeSync(fd);
    rmSync(stage, { recursive: true, force: true });
  }
}

export function reindex(store: Store): number {
  const pages = new Pages(store, new Events());
  return store.transaction(() => {
    store.db.exec('DELETE FROM search');
    const all = store.all('pages'); for (const page of all) pages.index(page);
    return all.length;
  });
}
export function createUser(store: Store, input: { email: string; name: string; password: string; isAdmin?: boolean }) {
  return newUser(store, { email: email.parse(input.email), name: text.parse(input.name), password: password.parse(input.password), isAdmin: input.isAdmin ?? false });
}
export function resetPassword(store: Store, address: string, value: string): void {
  const user = store.all('users').find(user => user.email === email.parse(address));
  if (!user) throw new Error('User not found.');
  Object.assign(user, passwordFields(password.parse(value))); store.put('users', user);
  store.db.prepare('DELETE FROM sessions WHERE userId=?').run(user.id);
}

const usage = 'Commands: create-user --email <email> --name <name> --password <password> [--admin]; reset-password --email <email> --password <password>; backup [--out <file>]; restore <file> [--force]; reindex';
export async function runCli(args: string[], options: { dataDir?: string } = {}): Promise<string> {
  const dataDir = options.dataDir ?? process.env.CAIRN_DATA_DIR ?? './data';
  const [command, ...rest] = args;
  if (!command || command === '--help' || command === 'help') return usage;
  const supported: Record<string, string[]> = { 'create-user': ['email', 'name', 'password', 'admin'], 'reset-password': ['email', 'password'], backup: ['out'], restore: ['force'], reindex: [] };
  if (!Object.hasOwn(supported, command)) throw new Error(usage);
  const flags: Record<string, string | boolean> = {}; const positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    if (!rest[i].startsWith('--')) { positional.push(rest[i]); continue; }
    const name = rest[i].slice(2);
    if (!supported[command].includes(name) || name in flags) throw new Error(`Unknown or repeated option: --${name}`);
    if (name === 'admin' || name === 'force') flags[name] = true;
    else { const value = rest[++i]; if (!value || value.startsWith('--')) throw new Error(`--${name} needs a value.`); flags[name] = value; }
  }
  function required(name: string): string { const value = flags[name]; if (typeof value !== 'string' || !value) throw new Error(`--${name} is required.`); return value; }
  if (command === 'restore') {
    if (positional.length !== 1) throw new Error('restore requires exactly one backup filename.');
    await restoreBackup(positional[0], dataDir, flags.force === true); return 'Backup restored. Restart the server before continuing.';
  }
  if (positional.length) throw new Error('Unexpected command arguments.');
  const store = new Store(dataDir);
  try {
    if (command === 'create-user') { const user = createUser(store, { email: required('email'), name: required('name'), password: required('password'), isAdmin: flags.admin === true }); return `Created user ${user.email}.`; }
    if (command === 'reset-password') { resetPassword(store, required('email'), required('password')); return 'Password reset; existing sessions revoked.'; }
    if (command === 'reindex') return `Indexed ${reindex(store)} pages.`;
    const output = typeof flags.out === 'string' ? flags.out : join(dataDir, `cairn-backup-${now().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)}.zip`);
    await createBackup(store, output); return `Backup saved to ${output}.`;
  } finally { store.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runCli(process.argv.slice(2)).then(message => console.log(message)).catch(error => { console.error(error instanceof Error ? error.message : 'CLI command failed.'); process.exitCode = 1; });
}
