# Building iOS, Android and other clients for Cairn

Cairn's web app is one client of a public HTTP API. Native apps use the same API; nothing in the
server is specific to the browser. Until native apps exist, the web app installs to the home
screen on iOS and Android (it ships a web manifest and service worker) and has a phone layout.

## The API

- Base URL: `https://<server>/api/v1` (identical to `/api`; `/api/v1` is the stable prefix).
- Machine-readable description: `GET /api/openapi.json` (OpenAPI 3.1). Generate Swift and Kotlin
  clients from it, for example with `openapi-generator`.
- Shapes: `shared/types.ts` is the source of truth for every request and response.
- Health check: `GET /api/health`.

## Signing in

Two options, both ending in a bearer credential sent as `Authorization: Bearer <secret>`:

1. **OAuth 2.1 with PKCE (recommended).** Discover endpoints at
   `/.well-known/oauth-authorization-server`, register the app once with `POST /oauth/register`
   (custom URL schemes such as `cairn://oauth` are accepted as redirect URIs), open
   `/oauth/authorize` in `ASWebAuthenticationSession` / Custom Tabs, exchange the code at
   `/oauth/token`. Access tokens last an hour; refresh tokens rotate and last 60 days. The person
   approves the app on a consent screen and can revoke it under Settings → AI & MCP.
2. **Email and password.** `POST /api/v1/auth/login` with `{ "email", "password", "token": true }`
   returns `sessionToken`. Store it in the Keychain / Keystore. `POST /api/v1/auth/logout` ends it.

With a bearer credential the `X-Cairn-Client` header is optional; send a stable per-install id
anyway so the server can tell the app's own changes apart in live events.

## Staying in sync

- `GET /api/v1/workspaces/:id/events` is a Server-Sent Events stream of small `LiveEvent`s
  (`page`, `members`, `home`, `stickies`, `ping`). On an event, refetch the affected resource.
- For offline use: cache `GET /workspaces/:id/tree`, pages and rows; queue writes and replay them.
  Page bodies are last-write-wins today; `updatedAt` tells you whether your copy is stale.

## What a phone client should show

The web app's phone layout is the reference (see `web/src/Shell.tsx`, `web/src/db/PhoneView.tsx`):
a tab bar (Home, Pages, New, Search, More); databases as one group at a time with large cards
instead of side-by-side columns; calendars and timelines as an agenda; menus as bottom sheets.

## Files and images

`POST /api/v1/workspaces/:id/files` (multipart `file`) returns a URL to embed in a page body as
an `image` node. Fetch files with the same bearer credential.

## Not there yet

Push notifications (APNs / FCM), real-time co-editing, and a delta sync endpoint. They are on the
roadmap; the event stream and `updatedAt` cover foreground use.
