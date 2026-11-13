import type { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { LiveEvent, Page } from '../../shared/types.ts';
import { membership, type Env } from './common.ts';
import { credentialActor } from './credentials.ts';
import { Pages } from './pages.ts';

export function registerEvents(app: Hono<Env>, pages: Pages) {
  app.get('/api/workspaces/:wid/events', c => {
    const actor = c.get('actor');
    const wid = c.req.param('wid');
    membership(pages.s, actor, wid);
    return streamSSE(c, async stream => {
      let done = false;
      let finish!: () => void;
      const finished = new Promise<void>(resolve => { finish = resolve; });
      const stop = () => {
        if (done) return;
        done = true;
        clearInterval(timer);
        unsubscribe();
        unsubscribeUser();
        finish();
      };
      const send = (event: LiveEvent) => {
        if (done) return;
        const current = credentialActor(pages.s, c);
        const member = pages.s.db.prepare(
          'SELECT role FROM memberships WHERE workspaceId=? AND userId=?',
        ).get(wid, actor.user.id);
        if (!current || !member) { stop(); return; }
        if (event.type === 'page' || event.type === 'comments') {
          const page = pages.s.get<Page>('pages', event.pageId);
          if (!page || !pages.visible(page, current, true)) return;
        }
        void stream.writeSSE({ data: JSON.stringify(event) }).catch(stop);
      };
      const unsubscribe = pages.events.subscribe(wid, send);
      const unsubscribeUser = pages.events.subscribeUser(actor.user.id,send);
      const timer = setInterval(() => send({ type: 'ping' }), 25000);
      timer.unref();
      stream.onAbort(stop);
      await finished;
    });
  });
}
