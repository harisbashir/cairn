import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/db.ts';
import { Pages } from '../src/pages.ts';
import { Events } from '../src/events.ts';
import { Hono } from 'hono';
import { Notifications, registerNotifications, reminderFireAt } from '../src/notifications.ts';
let s: Store, dir: string, pages: Pages, events: Events, n: Notifications;
const user = (id: string) => ({
  id,
  email: id + '@example.com',
  name: id,
  disabled: false,
  prefs: {
    timezone: 'UTC',
    reminderHour: 9,
    notify: { push: true, email: true, mentions: true, assigned: true, comments: true },
  },
});
const actor: any = { user: user('a'), actorType: 'user', clientId: null };
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'notify-'));
  s = new Store(dir);
  events = new Events();
  pages = new Pages(s, events);
  for (const id of ['a', 'b', 'c']) s.put('users', user(id));
  s.put('workspaces', { id: 'w' });
  for (const id of ['a', 'b', 'c'])
    s.db.prepare('INSERT INTO memberships VALUES(?,?,?,?)').run('w', id, 'member', '2026-01-01');
  n = new Notifications(s, pages, events, { clock: () => new Date('2026-11-12T10:00:00Z') });
});
afterEach(() => {
  n.close();
  s.close();
  rmSync(dir, { recursive: true, force: true });
});
it('calculates local date reminder times across daylight savings', () => {
  expect(reminderFireAt('2026-11-12', 0, user('b') as any)).toBe('2026-11-12T09:00:00.000Z');
  expect(reminderFireAt('2026-07-12', 60, { prefs: { timezone: 'America/Toronto', reminderHour: 9 } } as any)).toBe(
    '2026-07-12T12:00:00.000Z',
  );
});
it('notifies new mentions once, excludes self and invisible recipients', async () => {
  const p = pages.create(actor, 'w', { title: 'Hello' });
  const before = structuredClone(p);
  p.content = {
    type: 'doc',
    content: [
      { type: 'mention', attrs: { kind: 'user', id: 'b' } },
      { type: 'mention', attrs: { kind: 'user', id: 'a' } },
    ],
  };
  await n.pageChanged(actor, p, before);
  expect(n.list('b')).toHaveLength(1);
  await n.pageChanged(actor, p, p);
  expect(n.list('b')).toHaveLength(1);
  p.visibility = 'private';
  s.put('pages', p);
  await n.pageChanged(actor, p, before);
  expect(s.all<any>('notifications').filter((item) => item.userId === 'b')).toHaveLength(1);
  expect(n.list('b')).toHaveLength(0);
  expect(n.list('a')).toHaveLength(0);
});
it('fires once, marks occurrences over 24 hours late without delivering', async () => {
  const p = pages.create(actor, 'w', { title: 'Reminder' });
  p.reminders = [
    {
      id: 'r',
      dateProp: null,
      at: '2026-11-12T09:00:00Z',
      offsetMinutes: 0,
      userIds: ['b'],
      personProp: null,
      createdBy: 'a',
      lastFiredFor: null,
    },
  ];
  s.put('pages', p);
  await n.runReminders();
  await n.runReminders();
  expect(n.list('b')).toHaveLength(1);
  p.reminders[0].at = '2026-11-10T09:00:00Z';
  p.reminders[0].lastFiredFor = null;
  s.put('pages', p);
  await n.runReminders();
  expect(n.list('b')).toHaveLength(1);
  expect(s.get('pages', p.id).reminders[0].lastFiredFor).toBe('2026-11-10T09:00:00Z');
});
it('removes expired push endpoints and sends escaped email without leaking SMTP secrets', async () => {
  const push = vi.fn().mockRejectedValue({ statusCode: 410 }),
    sendMail = vi.fn().mockResolvedValue({});
  n = new Notifications(s, pages, events, { pushSender: push, mailTransport: { sendMail } });
  s.put('mailSettings', { id: 'smtp', enabled: true, host: 'smtp', password: 'secret', from: 'Cairn' });
  s.put('pushSubscriptions', {
    id: 'p',
    userId: 'b',
    subscription: { endpoint: 'https://push.test/p', keys: { p256dh: 'k', auth: 'a' } },
  });
  const p = pages.create(actor, 'w', { title: '<Hello>' });
  await n.notify('b', p, 'mention', '<unsafe>', actor);
  expect(s.get('pushSubscriptions', 'p')).toBeUndefined();
  expect(sendMail).toHaveBeenCalledOnce();
  expect(sendMail.mock.calls[0][0].html).toContain('&lt;unsafe&gt;');
  expect(n.mailSettings().password).toBe('');
  expect(n.mailSettings().hasPassword).toBe(true);
});
it('notifies new assignees and de-duplicates comment participants and mentions', async () => {
  const db = pages.create(actor, 'w', { kind: 'database', schema: [{ id: 'people', name: 'People', type: 'person' }] });
  const p = pages.create(actor, 'w', { kind: 'row', parentId: db.id, title: 'Task' });
  const old = structuredClone(p);
  p.props.people = ['a', 'b'];
  await n.pageChanged(actor, p, old);
  await n.pageChanged(actor, p, p);
  expect(n.list('b').map((v) => v.kind)).toEqual(['assigned']);
  const bActor: any = { ...actor, user: user('b') };
  const comment: any = { body: 'Hi @[a](cairn://user/a)', createdBy: 'b' };
  await n.commentAdded(bActor, p, comment, [{ createdBy: 'a' } as any, { createdBy: 'c' } as any]);
  expect(n.list('a')).toHaveLength(1);
  expect(n.list('c')).toHaveLength(1);
  expect(n.list('b')).toHaveLength(1);
});
it('targets notification streams to one user and honors category preferences', async () => {
  const b = vi.fn(),
    c = vi.fn();
  events.subscribeUser('b', b);
  events.subscribeUser('c', c);
  const p = pages.create(actor, 'w', { title: 'Target' });
  await n.notify('b', p, 'mention', 'Mention', actor);
  expect(b).toHaveBeenCalledWith({ type: 'notifications' });
  expect(c).not.toHaveBeenCalled();
  const userB = s.get('users', 'b');
  userB.prefs.notify.mentions = false;
  s.put('users', userB);
  await n.notify('b', p, 'mention', 'Ignored', actor);
  expect(n.list('b')).toHaveLength(1);
});
it('waits for each recipient timezone while avoiding duplicate early deliveries', async () => {
  const b = s.get('users', 'b');
  b.prefs.timezone = 'America/Toronto';
  s.put('users', b);
  const p = pages.create(actor, 'w', { title: 'Zones' });
  p.reminders = [
    {
      id: 'r',
      dateProp: 'date',
      at: null,
      offsetMinutes: 0,
      userIds: ['b', 'c'],
      personProp: null,
      createdBy: 'a',
      lastFiredFor: null,
    },
  ];
  p.props.date = '2026-11-12';
  s.put('pages', p);
  await n.runReminders();
  await n.runReminders();
  expect(n.list('c')).toHaveLength(1);
  expect(n.list('b')).toHaveLength(0);
  n.options.clock = () => new Date('2026-11-12T15:00:00Z');
  await n.runReminders();
  expect(n.list('c')).toHaveLength(1);
  expect(n.list('b')).toHaveLength(1);
  expect(s.get('pages', p.id).reminders[0].lastFiredFor).toBe('2026-11-12');
});

it('keeps SMTP passwords write-only and scopes read and push endpoints to the caller', async () => {
  const app = new Hono<any>();
  app.use('*', async (c, next) => {
    c.set('actor', { ...actor, user: { ...actor.user, isAdmin: true } });
    await next();
  });
  registerNotifications(app, n);
  const request = (path: string, method = 'GET', value?: unknown) =>
    app.request(path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      ...(value ? { body: JSON.stringify(value) } : {}),
    });
  let response = await request('/api/admin/mail', 'PUT', {
    enabled: true,
    host: 'smtp.test',
    port: 587,
    secure: false,
    username: 'user',
    password: 'secret',
    from: 'Cairn <cairn@example.com>',
  });
  expect(await response.json()).toMatchObject({ password: '', hasPassword: true });
  response = await request('/api/admin/mail');
  expect(JSON.stringify(await response.json())).not.toContain('secret');
  await request('/api/admin/mail', 'PUT', {
    enabled: true,
    host: 'smtp.test',
    port: 587,
    secure: false,
    username: 'user',
    password: '',
    from: 'Cairn',
  });
  expect(s.get('mailSettings', 'smtp').password).toBe('secret');
  s.put('pushSubscriptions', {
    id: 'other',
    userId: 'b',
    subscription: { endpoint: 'https://push.test' },
    device: 'Phone',
    createdAt: 'now',
  });
  expect(await (await request('/api/push/subscriptions')).json()).toEqual([]);
  const p = pages.create(actor, 'w', { title: 'Notification' });
  await n.notify('a', p, 'reminder', 'Due');
  await n.notify('b', p, 'reminder', 'Due');
  expect(await (await request('/api/notifications/count')).json()).toEqual({ unread: 1 });
  await request('/api/notifications/read', 'POST', {});
  expect(n.list('a')[0].read).toBe(true);
  expect(n.list('b')[0].read).toBe(false);
});
it('only notifies added mentions on comment edits', async () => {
  const p = pages.create(actor, 'w', { title: 'Edited comment' });
  await n.commentChanged(actor, p, 'Hi @[b](cairn://user/b) and @[c](cairn://user/c)', 'Hi @[b](cairn://user/b)');
  expect(n.list('b')).toHaveLength(0);
  expect(n.list('c')).toHaveLength(1);
});
it('REST accepts timezone and nested notification preferences and rejects invalid timezones', async () => {
  const { createApp } = await import('../src/app.ts');
  const app = createApp({ dataDir: join(dir, 'api') });
  const signup = await app.request('/api/auth/signup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Cairn-Client': 'notifications-test' },
    body: JSON.stringify({ name: 'Owner', email: 'owner@example.com', password: 'password123' }),
  });
  expect(signup.status, await signup.clone().text()).toBe(200);
  const cookie = signup.headers.get('set-cookie')!.split(';')[0];
  const request = (value: unknown) =>
    app.request('/api/me', {
      method: 'PATCH',
      headers: { Cookie: cookie, 'Content-Type': 'application/json', 'X-Cairn-Client': 'notifications-test' },
      body: JSON.stringify(value),
    });
  const response = await request({ prefs: { timezone: 'America/Toronto', reminderHour: 14, notify: { email: true } } });
  expect(response.status).toBe(200);
  expect(((await response.json()) as any).prefs).toMatchObject({
    timezone: 'America/Toronto',
    reminderHour: 14,
    notify: { email: true, push: true, mentions: true, comments: true, assigned: true },
    capture: null,
  });
  expect((await request({ prefs: { timezone: 'Mars/Base' } })).status).toBe(400);
  expect((await request({ prefs: { reminderHour: 24 } })).status).toBe(400);
});
it('upserts push endpoints and reports failed delivery without exposing service credentials', async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    n.options.pushSender = vi.fn().mockRejectedValue({ statusCode: 500, message: 'smtp password secret' });
    n.options.mailTransport = { sendMail: vi.fn().mockRejectedValue(new Error('smtp password secret')) };
    const app = new Hono<any>();
    app.use('*', async (c, next) => {
      c.set('actor', { ...actor, user: { ...actor.user, isAdmin: true } });
      await next();
    });
    registerNotifications(app, n);
    const request = (path: string, method = 'POST', value: unknown = {}) =>
      app.request(path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
    const input = {
      subscription: { endpoint: 'https://push.test/device', keys: { p256dh: 'public', auth: 'auth' } },
      device: 'Phone',
    };
    const first = (await (await request('/api/push/subscriptions', 'POST', input)).json()) as any;
    const second = (await (
      await request('/api/push/subscriptions', 'POST', { ...input, device: 'Updated' })
    ).json()) as any;
    expect(second.id).toBe(first.id);
    expect(s.all('pushSubscriptions')).toHaveLength(1);
    expect(await (await request('/api/push/test')).json()).toMatchObject({ ok: false });
    s.put('mailSettings', { id: 'smtp', enabled: true, password: 'secret' });
    const response = await request('/api/admin/mail/test');
    expect(await response.json()).toEqual({ ok: false, message: 'Email delivery failed.' });
    expect(JSON.stringify(log.mock.calls)).not.toContain('secret');
  } finally {
    log.mockRestore();
  }
});
