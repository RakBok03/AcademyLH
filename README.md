# AcademyLH

AcademyLH is a Telegram Mini App for an internal academy. It combines onboarding lessons, quizzes, practical tasks, a leaderboard, and an admin panel for managing academy content.

The app is built as a single Node.js service: Express serves the API and the production React build, PostgreSQL stores the data, and Telegram/PuzzleBot/NocoDB integrations are optional runtime integrations configured through environment variables.

## Main Features

- Telegram Mini App authentication through Telegram `initData`.
- Student home screen with profile, academy progress, score, title, tasks, tests, and leaderboard.
- Course sections with lessons, media, completion tracking, and course-linked quizzes.
- Test series with collapsible groups, quiz attempts, scoring, weighted scores, and attempt history.
- Practical tasks with comments, file uploads, optional menu/dish lookup from NocoDB, and admin review.
- Admin panel for users, submissions, tasks, courses, quiz series, quizzes, rich-text descriptions, media uploads, and reward decisions.
- Leaderboard pagination with "show more" loading.
- Optional Telegram/PuzzleBot notifications after task review.

## Tech Stack

- Frontend: React 18, Vite, lucide-react.
- Backend: Node.js 22, Express, JWT, Multer.
- Database: PostgreSQL.
- Deployment: Docker Compose.
- Integrations: Telegram Bot API, PuzzleBot API, NocoDB API.

## Repository Layout

```text
client/              React Mini App frontend
server/              Express API, database layer, services
server/db/           PostgreSQL schema, migrations, seed data
scripts/             Maintenance and import scripts
uploads/             Runtime upload storage, ignored by git
server/public/       Production frontend build, ignored by git
```

## Requirements

- Node.js 22 or newer.
- npm.
- PostgreSQL 16 for local development, or Docker Compose for containerized deployment.
- Telegram bot token for real Mini App authentication.

## Environment

Create a local `.env` from the example:

```bash
cp .env.example .env
```

Required production variables:

```env
NODE_ENV=production
PORT=3000
APP_URL=
DATABASE_URL=
POSTGRES_PASSWORD=
SESSION_SECRET=
TELEGRAM_BOT_TOKEN=
ADMIN_TELEGRAM_IDS=
```

Important rules:

- `SESSION_SECRET` must be a strong random string, at least 32 characters.
- `APP_URL` must be the public HTTPS Mini App URL.
- `ADMIN_TELEGRAM_IDS` is a comma-separated list of Telegram numeric user IDs.
- `ALLOW_UNVERIFIED_TELEGRAM=1` is only for local development without Telegram `initData`; do not enable it in production.
- Keep `.env`, database dumps, uploads, logs, and backups outside git.

Optional integrations:

- `CORS_ORIGINS`: comma-separated list of allowed browser origins. Falls back to `APP_URL`.
- `PUZZLEBOT_API_TOKEN`, `PUZZLEBOT_REVIEW_CHAT_ID`, `PUZZLEBOT_REWARD_COMMAND`: PuzzleBot review and reward integration.
- `NOCODB_BASE_URL`, `NOCODB_TOKEN`, `NOCODB_TABLE_ID`, `NOCODB_*_FIELD`: menu lookup integration for dish-photo tasks.
- `TELEGRAM_BOT_USERNAME`, `TELEGRAM_MINI_APP_SHORT_NAME`, `TELEGRAM_MINI_APP_DEEP_LINK_BASE`: optional Telegram deep-link helpers.

## Local Development

Install dependencies:

```bash
npm install
```

Prepare `.env`, then run migrations and seed data:

```bash
npm run db:migrate
npm run db:seed
```

Start the API and Vite dev server:

```bash
npm run dev
```

For local browser testing without Telegram, set this only in a local `.env`:

```env
ALLOW_UNVERIFIED_TELEGRAM=1
NODE_ENV=development
```

## Build

```bash
npm run build
npm start
```

`npm run build` writes the frontend build to `server/public/`. That directory is a generated artifact and is ignored by git.

## Docker Deployment

Create `.env` on the server first. Then build and start:

```bash
docker compose up -d --build
docker compose exec app node server/db/migrate.js
docker compose exec app node server/db/seed.js
```

By default the app container is exposed on:

```text
127.0.0.1:3001 -> app:3000
```

Put a reverse proxy in front of it and route the public HTTPS domain to `127.0.0.1:3001`.

Useful checks:

```bash
docker compose ps
docker logs academylh-app --tail=100
curl http://127.0.0.1:3001/api/health
```

## Admin Access

Admin access is based on Telegram user IDs listed in `ADMIN_TELEGRAM_IDS`.

When an admin opens the Mini App, the app assigns the `admin` role during Telegram authentication. Existing admins are preserved by the backend and are not downgraded on later login.

The admin panel can manage:

- course content and lessons;
- tasks and task descriptions;
- quiz series, quizzes, questions, answers, and descriptions;
- user submissions and reward points;
- content media uploads.

## Maintenance Scripts

```bash
npm run db:migrate
npm run db:seed
npm run db:backfill:alcohol-description
npm run db:backfill:quiz-series
npm run db:backfill:spaces-blocks
npm run extract:puzzlebot
npm run import:legacy-users
```

Legacy user import reads from NocoDB and PuzzleBot through environment variables:

```env
NOCODB_IMPORT_BASE_URL=
NOCODB_IMPORT_TOKEN=
NOCODB_USERS_TABLE_ID=
PUZZLEBOT_IMPORT_API_TOKEN=
PUZZLEBOT_IMPORT_DELAY_MS=
PUZZLEBOT_IMPORT_RETRIES=
PUZZLEBOT_IMPORT_TIMEOUT_MS=
```

Dry-run example:

```bash
npm run import:legacy-users -- --dry-run --limit=10
```

## Security Notes

- Never commit `.env` or real credentials.
- Rotate any credential that was ever committed to a public repository.
- Keep the repository history clean when publishing a public copy.
- Keep uploads restricted to the application upload directory.
- In production, the app hides internal error details and serves non-image uploads as attachments.
- Prefer a private repository or protected branch for production work.

## API Overview

Public runtime endpoints are under `/api` and require a JWT after Telegram authentication:

- `POST /api/auth/telegram`
- `GET /api/home`
- `GET /api/me`
- `GET /api/courses`
- `GET /api/quizzes`
- `GET /api/leaderboard`
- `GET /api/tasks`
- `POST /api/tasks/:slug/submissions`

Admin endpoints are under `/api/admin/*` and require the `admin` role.
