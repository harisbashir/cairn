import type { Hono } from 'hono';
import { z } from 'zod';
import webpush from 'web-push';
import nodemailer from 'nodemailer';
import type {
  Comment,
  DocNode,
  MailSettings,
  Notification,
  NotificationKind,
  Page,
  Reminder,
  User,
} from '../../shared/types.ts';
import { Store, id } from './db.ts';
import { body, fail, membership, type Actor, type Env } from './common.ts';
import type { Pages } from './pages.ts';
import type { Events } from './events.ts';
interface StoredNotification extends Notification {
  userId: string;
}
interface Subscription {
  id: string;
  userId: string;
  device: string;
  createdAt: string;
  subscription: { endpoint: string; keys: { p256dh: string; auth: string } };
}
export interface NotificationOptions {
  clock?: () => Date;
  pushSender?: (subscription: any, payload: string, options: any) => Promise<unknown>;
  mailTransport?: { sendMail: (message: any) => Promise<unknown> };
}
const escape = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const mentions = (node: DocNode | null): Set<string> => {
  const result = new Set<string>();
  const walk = (n: DocNode) => {
    if (n.type === 'mention' && n.attrs?.kind === 'user' && typeof n.attrs.id === 'string') result.add(n.attrs.id);
    n.content?.forEach(walk);
  };
  if (node) walk(node);
  return result;
};
const commentMentions = (text: string) =>
  new Set([...text.matchAll(/@\[[^\]]*\]\(cairn:\/\/user\/([^\s)]+)\)/g)].map((m) => m[1]));
/** Convert a wall-clock hour to an instant, iterating offsets to account for DST. */
export function reminderFireAt(occurrence: string, offset: number, user: User): string {
  let instant = Date.parse(occurrence);
  if (/^\d{4}-\d{2}-\d{2}$/.test(occurrence)) {
    const target = Date.parse(occurrence + 'T' + String(user.prefs?.reminderHour ?? 9).padStart(2, '0') + ':00:00Z');
    instant = target;
    const format = new Intl.DateTimeFormat('en-CA', {
      timeZone: user.prefs?.timezone ?? 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    for (let i = 0; i < 4; i++) {
      const parts = Object.fromEntries(format.formatToParts(new Date(instant)).map((p) => [p.type, p.value]));
      const local = Date.parse(
        `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}Z`,
      );
      const next = instant + target - local;
      if (next === instant) break;
      instant = next;
    }
  }
  return new Date(instant - offset * 60000).toISOString();
}
export class Notifications {
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;
  constructor(
    public s: Store,
    public pages: Pages,
    public events: Events,
    public options: NotificationOptions = {},
  ) {}
  clock() {
    return this.options.clock?.() ?? new Date();
  }
  start() {
    if (!this.timer) {
      this.timer = setInterval(
        () => void this.runReminders().catch(() => console.error('Reminder scheduling failed.')),
        60000,
      );
      this.timer.unref();
    }
  }
  close() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
  canSee(userId: string, page: Page) {
    const u = this.s.get<User>('users', userId);
    if (!u || u.disabled) return false;
    try {
      this.pages.get({ user: u, actorType: 'user', clientId: null }, page.id);
      return true;
    } catch {
      return false;
    }
  }
  list(userId: string, workspaceId?: string | null) {
    return this.s
      .all<StoredNotification>('notifications')
      .filter(
        (n) =>
          n.userId === userId &&
          (!workspaceId || n.workspaceId === workspaceId) &&
          (!n.pageId ||
            (!!this.s.get<Page>('pages', n.pageId) && this.canSee(userId, this.s.get<Page>('pages', n.pageId)!))),
      )
      .sort((a, b) => b.at.localeCompare(a.at))
      .map(({ userId, ...n }) => n);
  }
  prune() {
    const cutoff = this.clock().getTime() - 90 * 86400000;
    for (const n of this.s.all<StoredNotification>('notifications'))
      if (Date.parse(n.at) < cutoff) this.s.remove('notifications', n.id);
  }
  vapid() {
    let keys = this.s.get<any>('mailSettings', 'vapid');
    if (!keys) {
      keys = { id: 'vapid', ...webpush.generateVAPIDKeys() };
      this.s.put('mailSettings', keys);
    }
    return keys;
  }
  mailSettings(): MailSettings {
    const { id: _, ...value } = this.s.get<any>('mailSettings', 'smtp') ?? {};
    return {
      enabled: false,
      host: '',
      port: 587,
      secure: false,
      username: '',
      from: '',
      ...value,
      password: '',
      hasPassword: !!value.password,
    };
  }
  async push(userId: string, notification: Notification) {
    const keys = this.vapid();
    const subject =
      process.env.CAIRN_PUBLIC_URL ??
      'mailto:' + (this.s.all<User>('users').find((u) => u.isAdmin)?.email ?? 'admin@localhost');
    const payload = JSON.stringify({
      title: notification.title,
      body: notification.body,
      url: notification.pageId ? '/p/' + notification.pageId : '/',
      tag: notification.id,
    });
    let sent = 0,
      failed = 0;
    for (const subscription of this.s.all<Subscription>('pushSubscriptions').filter((p) => p.userId === userId)) {
      try {
        await (this.options.pushSender ?? webpush.sendNotification)(subscription.subscription, payload, {
          vapidDetails: { subject, publicKey: keys.publicKey, privateKey: keys.privateKey },
        });
        sent++;
      } catch (error: any) {
        failed++;
        if ([404, 410].includes(error?.statusCode)) this.s.remove('pushSubscriptions', subscription.id);
        else console.error('Push delivery failed.');
      }
    }
    return { sent, failed };
  }
  async mail(to: string, title: string, text: string, pageId: string | null) {
    const config = this.s.get<any>('mailSettings', 'smtp');
    if (!config?.enabled) throw new Error('Email delivery is not enabled.');
    const transport =
      this.options.mailTransport ??
      nodemailer.createTransport({
        host: config.host,
        port: config.port,
        secure: config.secure,
        ...(config.username ? { auth: { user: config.username, pass: config.password } } : {}),
      });
    const url =
      (process.env.CAIRN_PUBLIC_URL ?? 'http://localhost:3000').replace(/\/$/, '') +
      (pageId ? '/p/' + encodeURIComponent(pageId) : '/');
    await transport.sendMail({
      from: config.from,
      to,
      subject: title,
      text: text + '\n\n' + url,
      html: '<p>' + escape(text) + '</p><p><a href="' + escape(url) + '">Open in Cairn</a></p>',
    });
  }
  async notify(
    userId: string,
    page: Page,
    kind: NotificationKind,
    text: string,
    actor?: Actor,
    notificationId?: string,
  ) {
    if (userId === actor?.user.id || !this.canSee(userId, page)) return;
    const user = this.s.get<User>('users', userId)!;
    const pref =
      kind === 'mention' ? 'mentions' : kind === 'assigned' ? 'assigned' : kind === 'comment' ? 'comments' : null;
    if (pref && user.prefs?.notify?.[pref] === false) return;
    const n: StoredNotification = {
      id: notificationId ?? id(),
      userId,
      at: this.clock().toISOString(),
      kind,
      title: page.title,
      body: text.replace(/@\[([^\]]*)\]\(cairn:\/\/(?:user|date)\/[^)]*\)/g, '@$1').slice(0, 500),
      pageId: page.id,
      workspaceId: page.workspaceId,
      actorName: actor?.user.name ?? '',
      read: false,
    };
    this.s.put('notifications', n);
    this.events.emitUser(userId, { type: 'notifications' });
    if (user.prefs?.notify?.push !== false) await this.push(userId, n);
    if (user.prefs?.notify?.email && this.mailSettings().enabled)
      try {
        await this.mail(user.email, n.title, n.body, n.pageId);
      } catch (error) {
        console.error('Email delivery failed.');
      }
  }
  async pageChanged(actor: Actor, page: Page, before?: Page) {
    if (page.deletedAt || this.pages.isTemplate(page)) return;
    const deliveries: Promise<void>[] = [];
    const previous = mentions(before?.content ?? null);
    for (const user of mentions(page.content))
      if (!previous.has(user))
        deliveries.push(this.notify(user, page, 'mention', actor.user.name + ' mentioned you', actor));
    if (page.kind === 'row') {
      const schema = this.s.get<Page>('pages', page.parentId!)?.schema ?? [];
      for (const p of schema.filter((p) => p.type === 'person')) {
        const old = new Set(Array.isArray(before?.props[p.id]) ? (before!.props[p.id] as string[]) : []);
        for (const user of Array.isArray(page.props[p.id]) ? (page.props[p.id] as string[]) : [])
          if (!old.has(user))
            deliveries.push(this.notify(user, page, 'assigned', actor.user.name + ' assigned you', actor));
      }
    }
    await Promise.all(deliveries);
  }
  async commentAdded(actor: Actor, page: Page, comment: Comment, threadComments: Comment[] = []) {
    const people = new Map<string, NotificationKind>();
    people.set(page.createdBy, 'comment');
    for (const c of threadComments) people.set(c.createdBy, 'comment');
    for (const user of commentMentions(comment.body))
      if (!people.has(user) || this.s.get<User>('users', user)?.prefs?.notify?.mentions !== false)
        people.set(user, 'mention');
    await Promise.all([...people].map(([user, kind]) => this.notify(user, page, kind, comment.body, actor)));
  }
  async commentChanged(actor: Actor, page: Page, body: string, oldBody: string) {
    const previous = commentMentions(oldBody);
    await Promise.all(
      [...commentMentions(body)]
        .filter((user) => !previous.has(user))
        .map((user) => this.notify(user, page, 'mention', body, actor)),
    );
  }
  recipients(page: Page, r: Reminder) {
    const people = [
      ...new Set([
        ...r.userIds,
        ...(r.personProp && Array.isArray(page.props[r.personProp]) ? (page.props[r.personProp] as string[]) : []),
      ]),
    ];
    return (people.length ? people : [r.createdBy]).filter((u) => this.canSee(u, page));
  }
  occurrence(page: Page, r: Reminder) {
    const value = r.dateProp ? page.props[r.dateProp] : r.at;
    return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
  }
  async runReminders() {
    if (this.running) return;
    this.running = true;
    try {
      this.prune();
      const time = this.clock().getTime();
      for (const page of this.s.all<Page>('pages')) {
        if (page.deletedAt || page.isTemplate || this.pages.ancestors(page).some((p) => p.deletedAt || p.isTemplate))
          continue;
        for (const reminder of page.reminders ?? []) {
          const occurrence = this.occurrence(page, reminder);
          if (!occurrence || reminder.lastFiredFor === occurrence) continue;
          const people = this.recipients(page, reminder);
          let allDue = true;
          for (const userId of people) {
            const user = this.s.get<User>('users', userId)!;
            const due = Date.parse(reminderFireAt(occurrence, reminder.dateProp ? reminder.offsetMinutes : 0, user));
            if (due > time) {
              allDue = false;
              continue;
            }
            // Different timezones can become due on different ticks. The stable id makes
            // each recipient's delivery durable until the whole occurrence is finished.
            const key = `${reminder.id}:${occurrence}:${userId}`;
            if (!this.s.get('notifications', key) && time - due <= 86400000)
              await this.notify(userId, page, 'reminder', 'Reminder', undefined, key);
          }
          if (allDue) {
            // Deliveries await external services: preserve any page edits made meanwhile.
            const latest = this.s.get<Page>('pages', page.id);
            const current = latest?.reminders.find((item) => item.id === reminder.id);
            if (latest && current && this.occurrence(latest, current) === occurrence) {
              current.lastFiredFor = occurrence;
              this.s.put('pages', latest);
            }
          }
        }
      }
    } finally {
      this.running = false;
    }
  }
  upcoming(actor: Actor, wid: string, days: number) {
    const end = this.clock().getTime() + days * 86400000;
    const result = [];
    for (const page of this.pages.list(actor, wid)) {
      if (page.isTemplate || this.pages.ancestors(page).some((p) => p.isTemplate)) continue;
      for (const r of page.reminders ?? []) {
        const people = this.recipients(page, r);
        const occurrence = this.occurrence(page, r);
        if (!people.includes(actor.user.id) || !occurrence || r.lastFiredFor === occurrence) continue;
        const fireAt = reminderFireAt(occurrence, r.dateProp ? r.offsetMinutes : 0, actor.user);
        if (Date.parse(fireAt) >= this.clock().getTime() && Date.parse(fireAt) <= end)
          result.push({ pageId: page.id, title: page.title, icon: page.icon, fireAt, occurrence });
      }
    }
    return result.sort((a, b) => a.fireAt.localeCompare(b.fireAt));
  }
}
export function registerNotifications(app: Hono<Env>, n: Notifications) {
  app.get('/api/notifications', (c) => {
    const limit = Math.min(200, Math.max(1, Number(c.req.query('limit')) || 50));
    return c.json(
      n
        .list(c.get('actor').user.id, c.get('actor').workspaceId)
        .filter(
          (v) =>
            (c.req.query('unread') !== '1' || !v.read) && (!c.req.query('before') || v.at < c.req.query('before')!),
        )
        .slice(0, limit),
    );
  });
  app.get('/api/notifications/count', (c) =>
    c.json({ unread: n.list(c.get('actor').user.id, c.get('actor').workspaceId).filter((v) => !v.read).length }),
  );
  app.post('/api/notifications/read', async (c) => {
    const v = await body(c, z.object({ ids: z.array(z.string()).optional() }));
    for (const item of n.s.all<StoredNotification>('notifications'))
      if (
        item.userId === c.get('actor').user.id &&
        (!c.get('actor').workspaceId || item.workspaceId === c.get('actor').workspaceId) &&
        (!v.ids || v.ids.includes(item.id))
      ) {
        item.read = true;
        n.s.put('notifications', item);
      }
    n.events.emitUser(c.get('actor').user.id, { type: 'notifications' });
    return c.json({ ok: true });
  });
  app.get('/api/push/key', (c) => c.json({ publicKey: n.vapid().publicKey }));
  app.get('/api/push/subscriptions', (c) =>
    c.json(
      n.s
        .all<Subscription>('pushSubscriptions')
        .filter((s) => s.userId === c.get('actor').user.id)
        .map(({ id, device, createdAt }) => ({ id, device, createdAt })),
    ),
  );
  app.post('/api/push/subscriptions', async (c) => {
    const v = await body(
      c,
      z.object({
        subscription: z.object({
          endpoint: z.url().refine((v) => v.startsWith('https://')),
          keys: z.object({ p256dh: z.string().min(1), auth: z.string().min(1) }),
        }),
        device: z.string().max(200).optional(),
      }),
    );
    const userId = c.get('actor').user.id;
    const old = n.s
      .all<Subscription>('pushSubscriptions')
      .find((s) => s.subscription.endpoint === v.subscription.endpoint);
    if (old && old.userId !== userId) n.s.remove('pushSubscriptions', old.id);
    const value = {
      id: old?.userId === userId ? old.id : id(),
      userId,
      device: v.device ?? c.req.header('User-Agent')?.slice(0, 200) ?? 'This device',
      createdAt: old?.userId === userId ? old.createdAt : n.clock().toISOString(),
      subscription: v.subscription,
    };
    n.s.put('pushSubscriptions', value);
    return c.json({ id: value.id, device: value.device, createdAt: value.createdAt });
  });
  app.delete('/api/push/subscriptions/:id', (c) => {
    const s = n.s.get<Subscription>('pushSubscriptions', c.req.param('id'));
    if (!s || s.userId !== c.get('actor').user.id) fail(404, 'Subscription not found.');
    n.s.remove('pushSubscriptions', s.id);
    return c.json({ ok: true });
  });
  app.post('/api/push/test', async (c) => {
    const result = await n.push(c.get('actor').user.id, {
      id: id(),
      title: 'Cairn',
      body: 'Push notifications are working.',
      pageId: null,
    } as Notification);
    return c.json({
      ok: result.sent > 0 && result.failed === 0,
      message:
        result.sent === 0
          ? result.failed
            ? 'Push delivery failed.'
            : 'No push subscriptions found.'
          : result.failed
            ? 'Some devices could not be reached.'
            : 'Test push sent.',
    });
  });
  const admin = (c: any) => {
    if (!c.get('actor').user.isAdmin) fail(403, 'Administrator access required.');
  };
  app.get('/api/admin/mail', (c) => {
    admin(c);
    return c.json(n.mailSettings());
  });
  app.put('/api/admin/mail', async (c) => {
    admin(c);
    const v = await body(
      c,
      z.object({
        enabled: z.boolean(),
        host: z.string().max(300),
        port: z.number().int().min(1).max(65535),
        secure: z.boolean(),
        username: z.string().max(300),
        password: z.string().max(4096).optional(),
        from: z.string().max(500),
        hasPassword: z.boolean().optional(),
      }),
    );
    n.s.put('mailSettings', {
      ...v,
      id: 'smtp',
      password: v.password || n.s.get<any>('mailSettings', 'smtp')?.password || '',
    });
    return c.json(n.mailSettings());
  });
  app.post('/api/admin/mail/test', async (c) => {
    admin(c);
    const v = await body(c, z.object({ to: z.email().optional() }));
    try {
      await n.mail(v.to ?? c.get('actor').user.email, 'Cairn test email', 'Email notifications are working.', null);
      return c.json({ ok: true, message: 'Test email sent.' });
    } catch (error) {
      return c.json({
        ok: false,
        message: n.mailSettings().enabled ? 'Email delivery failed.' : 'Email delivery is not enabled.',
      });
    }
  });
  app.get('/api/workspaces/:wid/reminders', (c) => {
    const actor = c.get('actor');
    membership(n.s, actor, c.req.param('wid'));
    return c.json(n.upcoming(actor, c.req.param('wid'), Math.min(365, Math.max(1, Number(c.req.query('days')) || 14))));
  });
}
