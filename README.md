<p><img src="brand/wordmark.svg" alt="Cairn" height="44"></p>

**Cairn** is a self-hosted workspace for notes, docs and databases that is easy to find your way
around, with a built-in MCP server so AI agents work in the same pages you do.

- **Pages** that nest, with a block editor: headings, to-dos, lists, callouts, code, images, page links (`/` for blocks, `@` to link a page).
- **Databases** with table, board and list views, filters, sorts, typed properties and relations. Every row is a page.
- **Workspaces and people**: many workspaces per account, roles (owner, admin, member, viewer), invite links, private pages.
- **Wayfinding**: breadcrumbs everywhere, favorites, search and commands on ⌘K, trash with undo, version history.
- **AI built in**: an MCP endpoint at `/mcp` with 16 tools. Agent edits are labelled, logged and versioned.
- **Administration**: people, workspaces, sign-up policy and usage in one panel.
- **Sharing**: publish any page read-only with a link.
- One container, one SQLite file. Light and dark follow the system.

## Run

```bash
docker compose up -d --build      # serves on port 80; data in the cairn-data volume
```

Open it and create the first account, which becomes the administrator.
Settings: `CAIRN_BIND` (default `0.0.0.0:80`), `CAIRN_PUBLIC_URL`, `CAIRN_SECURE_COOKIES=1` when served only over HTTPS.

Back up by copying the volume (`cairn.db` plus `files/`).

## Connect an AI client

Create a token in **Settings → AI & MCP**, then:

```bash
claude mcp add --transport http cairn https://your-host/mcp --header "Authorization: Bearer cairn_..."
```

## Develop

```bash
npm install
npm run dev:server   # API on :8080
npm run dev:web      # web on :5173, proxied to the API
npm test && npm run typecheck
```

`docs/SPEC.md` is the API and MCP contract, `docs/DESIGN.md` the interface rules, `shared/types.ts` the shared types.
`scripts/import-notion.mjs` copies Notion databases into a workspace.

## Roadmap

Real-time co-editing, comments and mentions, email (invites, password reset), OAuth for MCP clients,
calendar and gallery views, templates, Markdown/CSV export, per-page permissions, SSO, Postgres option, mobile apps.
