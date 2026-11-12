import { afterEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof fs>();
  return { ...actual, mkdtempSync: vi.fn(actual.mkdtempSync), rmSync: vi.fn(actual.rmSync) };
});
import { Store } from '../src/db.ts';
import { BackupService } from '../src/backups.ts';

afterEach(() => { vi.restoreAllMocks(); });
it('records a failed backup when its temporary directory cannot be created', async () => {
  const dir = fs.mkdtempSync(join(tmpdir(), 'cairn-backup-failure-'));
  const store = new Store(dir), backups = new BackupService(store);
  try {
    backups.saveSettings({ ...backups.settings(), destinations: [{ id: 'local', name: 'Local', type: 'local', config: {}, hasSecret: false }] });
    vi.mocked(fs.mkdtempSync).mockImplementationOnce(() => { throw new Error('Disk full'); });
    const run = backups.start();
    await expect(backups.waitForIdle()).resolves.toBeUndefined();
    expect(backups.list().find(item => item.id === run.id)).toMatchObject({ status: 'failed', finishedAt: expect.any(String), downloadable: false });
  } finally { backups.close(); store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
it('contains cleanup errors in the background task and records the failure', async () => {
  const dir = fs.mkdtempSync(join(tmpdir(), 'cairn-backup-cleanup-'));
  const store = new Store(dir), backups = new BackupService(store);
  try {
    backups.saveSettings({ ...backups.settings(), destinations: [{ id: 'local', name: 'Local', type: 'local', config: {}, hasSecret: false }] });
    const actualRm = vi.mocked(fs.rmSync).getMockImplementation()!;
    vi.mocked(fs.rmSync).mockImplementation((path, options) => {
      if (String(path).includes('.backup-run-')) throw new Error('Cleanup denied');
      actualRm(path, options);
    });
    const run = backups.start();
    await expect(backups.waitForIdle()).resolves.toBeUndefined();
    expect(backups.list().find(item => item.id === run.id)).toMatchObject({ status: 'failed', finishedAt: expect.any(String) });
  } finally { vi.mocked(fs.rmSync).mockRestore(); backups.close(); store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
it('does not reject the detached job if the completion record cannot be saved', async () => {
  const dir = fs.mkdtempSync(join(tmpdir(), 'cairn-backup-save-'));
  const store = new Store(dir), backups = new BackupService(store);
  try {
    backups.saveSettings({ ...backups.settings(), destinations: [{ id: 'local', name: 'Local', type: 'local', config: {}, hasSecret: false }] });
    const put = store.put.bind(store);
    vi.spyOn(store, 'put').mockImplementation((table, value) => {
      if (table === 'backupRuns' && value.status !== 'running') throw new Error('Database unavailable');
      put(table, value);
    });
    const run = backups.start();
    await expect(backups.waitForIdle()).resolves.toBeUndefined();
    expect(run.status).toBe('failed');
    expect(run.finishedAt).toEqual(expect.any(String));
  } finally { backups.close(); store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
