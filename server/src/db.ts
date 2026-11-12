import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Page } from '../../shared/types.ts';
import { docToPlainText } from '../../shared/markdown.ts';

export const id = () => randomBytes(18).toString('base64url');
export const now = () => new Date().toISOString();
const tables = ['users', 'workspaces', 'pages', 'invites', 'tokens', 'versions', 'activity', 'files', 'layouts', 'stickies', 'calendars', 'feeds', 'oauthClients', 'oauthRequests', 'oauthCodes', 'oauthGrants', 'backupSettings', 'backupRuns'] as const;
export type Table = typeof tables[number];

export class Store {
  db: DatabaseSync;
  constructor(public dataDir: string) {
    mkdirSync(join(dataDir, 'files'), { recursive: true });
    this.db = new DatabaseSync(join(dataDir, 'cairn.db'));
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
    const version = Number(this.db.prepare('PRAGMA user_version').get()!.user_version);
    if (version < 1) {
      this.db.exec(`BEGIN;
        ${tables.map(table => `CREATE TABLE ${table} (
          id TEXT PRIMARY KEY,
          data TEXT NOT NULL CHECK(json_valid(data))
        );`).join('\n')}
        CREATE TABLE memberships (
          workspaceId TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
          userId TEXT REFERENCES users(id) ON DELETE CASCADE,
          role TEXT NOT NULL CHECK(role IN ('owner','admin','member','viewer')),
          joinedAt TEXT NOT NULL,
          PRIMARY KEY(workspaceId,userId)
        );
        CREATE TABLE sessions (
          hash TEXT PRIMARY KEY,
          userId TEXT REFERENCES users(id) ON DELETE CASCADE,
          expiresAt TEXT NOT NULL
        );
        CREATE TABLE settings (
          id INTEGER PRIMARY KEY CHECK(id=1),
          instanceName TEXT NOT NULL,
          allowSignup INTEGER NOT NULL CHECK(allowSignup IN (0,1))
        );
        INSERT INTO settings VALUES(1,'Cairn',0);
        CREATE VIRTUAL TABLE search USING fts5(id UNINDEXED, title, body);
        CREATE INDEX memberships_user ON memberships(userId);
        CREATE INDEX sessions_expiry ON sessions(expiresAt);
        CREATE UNIQUE INDEX users_email ON users(json_extract(data,'$.email'));
        CREATE INDEX pages_workspace ON pages(json_extract(data,'$.workspaceId'));
        PRAGMA user_version=1;
        COMMIT;
      `);
    }
    if (version < 2) {
      this.db.exec('BEGIN');
      try {
        for (const table of tables) this.db.exec(`CREATE TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY, data TEXT NOT NULL CHECK(json_valid(data)))`);
        this.reindex();
        this.db.exec('PRAGMA user_version=2; COMMIT');
      } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    }
  }
  indexPage(page: Page) {
    const text: string[] = [];
    const schema = page.kind === 'row' && page.parentId ? this.get<Page>('pages',page.parentId)?.schema ?? [] : [];
    for (const property of schema) {
      const value=page.props[property.id];
      if(value==null || ['person','relation','checkbox'].includes(property.type))continue;
      for(const item of Array.isArray(value)?value:[value]) {
        if(property.options){const option=property.options.find(o=>o.id===item);if(option)text.push(option.name);}
        else text.push(String(item));
      }
    }
    this.db.prepare('DELETE FROM search WHERE id=?').run(page.id);
    this.db.prepare('INSERT INTO search(id,title,body) VALUES(?,?,?)').run(page.id,page.title,docToPlainText(page.content)+' '+text.join(' '));
  }
  reindex() { this.db.exec('DELETE FROM search'); for(const page of this.all<Page>('pages'))this.indexPage(page); }

  defaults(table: Table, value: any): any {
    if (table === 'users') value.prefs = { theme: 'system', accent: 'blue', ...value.prefs };
    if (table === 'files') {
      let info; try { info=statSync(join(this.dataDir,'files',value.id)); } catch { /* An old upload may already be missing. */ }
      value.mime ??= value.type ?? 'application/octet-stream'; value.size ??= info?.size ?? 0;
      value.createdAt ??= info?.mtime.toISOString() ?? '1970-01-01T00:00:00.000Z';
    }
    if (table === 'pages') { value.cover ??= ''; value.updatedByType ??= 'user'; }
    return value;
  }

  all<T = any>(table: Table): T[] {
    return this.db.prepare(`SELECT data FROM ${table} ORDER BY rowid`).all().map(row => this.defaults(table, JSON.parse(String(row.data))));
  }
  get<T = any>(table: Table, key: string): T | undefined {
    const row = this.db.prepare(`SELECT data FROM ${table} WHERE id=?`).get(key);
    return row ? this.defaults(table, JSON.parse(String(row.data))) : undefined;
  }
  put(table: Table, value: { id: string; [key: string]: any }) {
    this.db.prepare(`INSERT INTO ${table}(id,data) VALUES(?,?)
      ON CONFLICT(id) DO UPDATE SET data=excluded.data`).run(value.id, JSON.stringify(value));
  }
  remove(table: Table, key: string) {
    this.db.prepare(`DELETE FROM ${table} WHERE id=?`).run(key);
  }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  close() { this.db.close(); }
}
