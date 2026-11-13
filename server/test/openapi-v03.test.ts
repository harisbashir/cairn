import { expect, it } from 'vitest';
import { Hono } from 'hono';
import { openapi } from '../src/openapi.ts';
it('documents v0.3 models and route request/response shapes', () => {
  const app = new Hono<any>();
  for (const path of [
    '/api/notifications',
    '/api/notifications/count',
    '/api/push/subscriptions',
    '/api/admin/mail',
    '/api/pages/:id/comments',
    '/api/pages/:id/backlinks',
    '/api/workspaces/:wid/templates',
    '/api/workspaces/:wid/changes',
    '/api/changes/:id',
  ])
    app.get(path, (c) => c.json({}));
  for (const path of [
    '/api/capture',
    '/api/notifications/read',
    '/api/pages/:id/comments',
    '/api/changes/undo',
    '/api/changes/:id/undo',
    '/api/pages/:id/save-as-template',
  ])
    app.post(path, (c) => c.json({}));
  app.put('/api/admin/mail', (c) => c.json({}));
  const doc = openapi(app) as any;
  const response = (path: string, method = 'get') =>
    doc.paths[path][method].responses['200'].content['application/json'].schema;
  expect(response('/notifications')).toEqual({ type: 'array', items: { $ref: '#/components/schemas/Notification' } });
  expect(response('/pages/{id}/comments')).toEqual({ type: 'array', items: { $ref: '#/components/schemas/Comment' } });
  expect(response('/changes/{id}')).toEqual({ $ref: '#/components/schemas/ChangeDetail' });
  expect(response('/capture', 'post').properties.page).toEqual({ $ref: '#/components/schemas/Page' });
  expect(response('/changes/undo', 'post').properties.conflicts).toBeDefined();
  const schemas = doc.components.schemas;
  for (const name of [
    'Repeat',
    'Reminder',
    'Notification',
    'NotifyPrefs',
    'MailSettings',
    'PushSubscriptionInfo',
    'TemplateSummary',
    'Backlink',
    'Comment',
    'ChangeSummary',
    'ChangeDetail',
    'RollupConfig',
    'FormulaConfig',
  ])
    expect(schemas[name], name).toBeDefined();
  expect(schemas.Page.properties.repeat).toBeDefined();
  expect(schemas.Property.properties.type.enum).toContain('formula');
  expect(schemas.MailSettings.properties.password.readOnly).not.toBe(true);
  expect(
    doc.paths['/admin/mail'].put.requestBody.content['application/json'].schema.properties.password.writeOnly,
  ).toBe(true);
});
