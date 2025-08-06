# AI_RULES

This repository is a Node.js backend service that powers a Stremio addon with admin tooling, scraping, and optional Real-Debrid integration.

Tech stack overview (5–10 bullets)
- Runtime: Node.js with Express for HTTP routing (REST-style endpoints).
- Language: JavaScript (CommonJS modules) — no TypeScript in this project.
- Database: SQLite via Sequelize ORM; file stored at /data/stremio_addon.db.
- Crawling/Scraping: Crawlee with CheerioCrawler for stateless scraping workflows.
- HTTP Client: Axios for external API calls (TMDB, trackers, Real-Debrid).
- Scheduling: node-cron for background workflows (crawler and tracker refresh).
- Logging: pino and pino-http (pretty printing enabled only in dev TTY).
- Config: dotenv for environment variables, centralized in src/config/config.js.
- Packaging/CI: Dockerfile for container builds; GitHub Actions workflow to publish to GHCR.
- Frontend (admin): Static HTML/JS served from public/admin.html consuming /admin/api endpoints.

Library usage rules
1) Web server and routing
- Use Express for all HTTP endpoints.
- Group addon endpoints in src/api/stremio.routes.js and admin endpoints in src/api/admin.routes.js.
- Do not introduce alternative frameworks (Fastify, Koa) or extra routers unless refactoring within Express.

2) Configuration and environment
- Load all environment variables through dotenv (already invoked in src/config/config.js).
- Add new config keys only in src/config/config.js and consume them via the config object.
- Fail fast in config.js if a truly required variable is missing; optional features should be guarded by flags.

3) Logging
- Use pino for application logs and pino-http for request logs (already wired in src/index.js).
- Do not add other logging libraries. Prefer structured logs (objects) and include context.

4) Database and models
- Use Sequelize for all persistence needs. Define models in src/database/models.js and import via src/database/connection.js.
- Do not access the SQLite file directly. Never mix in raw sqlite3 queries unless there’s a proven performance need and it is localized.
- For simple read/write helpers, extend src/database/crud.js.

5) Crawling and parsing
- Use Crawlee’s CheerioCrawler for scraping. Keep crawler logic in src/services/crawler.js.
- Use parse-torrent-title for parsing titles and magnet filenames. Extend src/services/parser.js for custom patterns.
- Avoid adding new scraping frameworks (Puppeteer/Playwright) unless absolutely necessary and discussed.

6) External APIs
- Use Axios for HTTP calls to TMDB, Real-Debrid, and trackers.
- TMDB integration must go through src/services/metadata.js (type-aware search and fetch).
- Real-Debrid integration must go through src/services/realdebrid.js. Do not call RD directly from route files.

7) Scheduling and background work
- Use node-cron only. Configure cron expressions in src/config/config.js and schedule in src/index.js.
- Long-running orchestrations must go through src/services/orchestrator.js.

8) Stremio addon behaviors
- Keep addon manifest, catalog, meta, and stream logic in src/api/stremio.routes.js.
- Respect the ID formats already in place (addonId:pending:threadId and IMDb tt...).
- Any stream-building or RD fallback behavior should reuse existing helpers and data models.

9) Admin UI and static assets
- Keep admin panel as static HTML/JS under public/. It should only call /admin/api endpoints.
- Do not introduce frontend frameworks or build steps for the admin panel unless explicitly requested.

10) Dependencies and changes
- Prefer small, focused utilities over new heavy dependencies.
- Before adding a package, check if an equivalent already exists in the project.
- Keep code simple and readable; avoid overengineering error handling or abstractions unless justified.

Notes on extensibility
- New catalogs or content types should be wired via orchestrator → crawler → parser → metadata → database → stremio routes flow.
- Add new admin operations to src/api/admin.routes.js and surface them in public/admin.html via fetch calls.