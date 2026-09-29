# SnipñDrip demo

UI + API. Optional Postgres via `DATABASE_URL`.

## Local

```bash
npm install
node src/index.js
```

## Postgres (Neon free)

1. Create project at https://neon.tech
2. Copy the connection string (starts with `postgresql://...`)
3. On Render: Environment → add `DATABASE_URL` = that string
4. Redeploy

On boot the app creates tables and seeds demo data if empty.

## Render

- Build: `npm install`
- Start: `node src/index.js`
- Env: `DATABASE_URL` (optional but recommended)

Health: `GET /health` → `{ storage: "postgres" | "memory" }`
