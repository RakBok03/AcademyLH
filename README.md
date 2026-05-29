# AcademyLH

Telegram Mini App for LOFT HALL Academy.

## Architecture

- React/Vite frontend, served by the Node app.
- Express API.
- PostgreSQL as the main source of truth.
- PuzzleBot is used only as a bot launcher and optional integration layer.
- Local upload storage for MVP; storage service is isolated so it can later be replaced with S3/R2/Supabase Storage.

## Local Development

```bash
npm install
cp .env.example .env
npm run db:migrate
npm run db:seed
npm run dev
```

## Production

```bash
docker compose up -d --build
docker compose exec app node server/db/migrate.js
docker compose exec app node server/db/seed.js
```

The container exposes the app on `127.0.0.1:3001`. Put the public app URL in `APP_URL` on the server and route the domain to this port through the reverse proxy.
