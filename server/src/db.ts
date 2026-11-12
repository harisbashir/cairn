import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

export const id = () => randomBytes(18).toString('base64url');
export const now = () => new Date().toISOString();
const tables = ['users', 'workspaces', 'pages', 'invites', 'tokens', 'versions', 'activity', 'files'] as const;
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
  }

  all<T = any>(table: Table): T[] {
    return this.db.prepare(`SELECT data FROM ${table} ORDER BY rowid`).all().map(row => JSON.parse(String(row.data)));
  }
  get<T = any>(table: Table, key: string): T | undefined {
    const row = this.db.prepare(`SELECT data FROM ${table} WHERE id=?`).get(key);
    return row ? JSON.parse(String(row.data)) : undefined;
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
