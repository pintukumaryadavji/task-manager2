# Taskboard – Task Management Web App

Full-stack app: Node.js + Express + JSON-file storage + WebSockets (no native modules, installs anywhere), vanilla JS frontend.

## Run
    npm install
    npm start        # http://localhost:3000

## Features (as per task)
- User authentication & authorization: register/login (bcrypt + JWT). First user = admin (sees all tasks); others see only their own.
- CRUD for tasks: create, read (search + status filter), update (edit / move status), delete.
- Real-time updates: WebSocket broadcasts every change; open two tabs to see it live (green dot = connected).
- Responsive design: works on desktop and mobile (board stacks into one column).

## API
POST /api/auth/register, POST /api/auth/login, GET /api/auth/me
GET/POST /api/tasks, PUT/DELETE /api/tasks/:id   (Authorization: Bearer <token>)

Set JWT_SECRET env var in production.

## Extras
Drag & drop between columns, sort, live stats/overdue count, rate-limited login, input validation, WebSocket heartbeat + auto-reconnect.

## Troubleshooting
- Port busy: `set PORT=3001 && npm start` (Windows cmd) or `PORT=3001 npm start`.
- Data lives in data.json (delete it to reset).

## v3 performance/security
- WebSocket pushes the changed task itself; clients update in place (no list re-download), renders batched per frame.
- Optimistic UI for status moves with rollback on error.
- gzip compression, static caching, O(1) lookups (Map indexes), async bcrypt (never blocks the server).
- Random JWT secret generated on first run (or set JWT_SECRET), CSP + security headers, per-user task cap.
