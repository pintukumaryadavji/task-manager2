const express = require('express');
const compression = require('compression');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const STATUSES = ['todo', 'in_progress', 'done'];
const PRIORITIES = ['low', 'medium', 'high'];
const MAX_TASKS_PER_USER = 500;

// ---------- JSON-file database (no native modules) with O(1) indexes ----------
const DB_FILE = path.join(__dirname, 'data.json');
let db = { users: [], tasks: [], seq: { user: 0, task: 0 } };
try { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch { /* first run */ }
let timer;
function flush() {
  clearTimeout(timer);
  fs.writeFileSync(DB_FILE + '.tmp', JSON.stringify(db));
  fs.renameSync(DB_FILE + '.tmp', DB_FILE);
}
const save = () => { clearTimeout(timer); timer = setTimeout(flush, 150); };
['SIGINT', 'SIGTERM'].forEach((s) => process.on(s, () => { flush(); process.exit(0); }));

// Secret: env var, or a random one generated once and kept in data.json (no insecure default)
const SECRET = process.env.JWT_SECRET || db.secret || (db.secret = crypto.randomBytes(32).toString('hex'));
save();

const usersById = new Map(db.users.map((u) => [u.id, u]));
const usersByEmail = new Map(db.users.map((u) => [u.email, u]));
const tasksById = new Map(db.tasks.map((t) => [t.id, t]));

const app = express();
app.disable('x-powered-by');
app.use(compression());
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin',
    'Content-Security-Policy': "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data:; frame-ancestors 'none'"
  });
  next();
});
app.use(express.json({ limit: '20kb' }));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '5m' }));

const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);
const sign = (u) => jwt.sign({ id: u.id, role: u.role, name: u.name }, SECRET, { expiresIn: '7d' });
const publicUser = (u) => ({ id: u.id, name: u.name, email: u.email, role: u.role });
const view = (t) => ({ ...t, owner: (usersById.get(t.user_id) || {}).name || 'Unknown' });
const now = () => new Date().toISOString();

// Rate limit login/register: 20 tries / minute / IP
const hits = new Map();
setInterval(() => hits.clear(), 60000).unref();
function limiter(req, res, next) {
  const n = (hits.get(req.ip) || 0) + 1;
  hits.set(req.ip, n);
  if (n > 20) return res.status(429).json({ error: 'Too many attempts. Try again in a minute.' });
  next();
}

// ---------- Authentication ----------
function auth(req, res, next) {
  try {
    const p = jwt.verify((req.headers.authorization || '').replace('Bearer ', ''), SECRET);
    const u = usersById.get(p.id);
    if (!u) throw new Error('gone');
    req.user = { id: u.id, role: u.role, name: u.name };
    next();
  } catch {
    res.status(401).json({ error: 'Please log in again.' });
  }
}

app.post('/api/auth/register', limiter, wrap(async (req, res) => {
  const { name, email, password } = req.body || {};
  if (!name || !email || !password) return res.status(400).json({ error: 'Name, email and password are required.' });
  if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
  if (String(name).length > 60) return res.status(400).json({ error: 'Name is too long.' });
  if (String(password).length < 6 || String(password).length > 100) return res.status(400).json({ error: 'Password must be 6-100 characters.' });
  const mail = email.trim().toLowerCase();
  if (usersByEmail.has(mail)) return res.status(409).json({ error: 'This email is already registered.' });
  const hash = await bcrypt.hash(String(password), 10); // async: doesn't block other requests
  if (usersByEmail.has(mail)) return res.status(409).json({ error: 'This email is already registered.' });
  const user = { id: ++db.seq.user, name: String(name).trim(), email: mail, password: hash, role: db.users.length === 0 ? 'admin' : 'user' };
  db.users.push(user); usersById.set(user.id, user); usersByEmail.set(mail, user); save();
  res.status(201).json({ token: sign(user), user: publicUser(user) });
}));

app.post('/api/auth/login', limiter, wrap(async (req, res) => {
  const { email, password } = req.body || {};
  const user = usersByEmail.get(String(email || '').trim().toLowerCase());
  if (!user || !(await bcrypt.compare(String(password || ''), user.password)))
    return res.status(401).json({ error: 'Wrong email or password.' });
  res.json({ token: sign(user), user: publicUser(user) });
}));

app.get('/api/auth/me', auth, (req, res) => res.json({ user: publicUser(usersById.get(req.user.id)) }));

// ---------- Tasks CRUD (users: own tasks, admin: all) ----------
const canAccess = (user, t) => t && (user.role === 'admin' || t.user_id === user.id);
function validate(b, partial) {
  if (!partial || b.title !== undefined) {
    if (!b.title || !String(b.title).trim()) return 'Title is required.';
    if (String(b.title).length > 120) return 'Title must be 120 characters or less.';
  }
  if (b.description !== undefined && String(b.description).length > 500) return 'Description must be 500 characters or less.';
  if (b.status !== undefined && !STATUSES.includes(b.status)) return 'Invalid status.';
  if (b.priority !== undefined && !PRIORITIES.includes(b.priority)) return 'Invalid priority.';
  if (b.due_date && !/^\d{4}-\d{2}-\d{2}$/.test(b.due_date)) return 'Invalid due date.';
  return null;
}

app.get('/api/tasks', auth, (req, res) => {
  const { status } = req.query, q = String(req.query.q || '').toLowerCase();
  res.json(db.tasks
    .filter((t) => canAccess(req.user, t) && (!status || t.status === status) &&
      (!q || t.title.toLowerCase().includes(q) || (t.description || '').toLowerCase().includes(q)))
    .sort((a, b) => b.id - a.id).map(view));
});

app.post('/api/tasks', auth, (req, res) => {
  const err = validate(req.body, false);
  if (err) return res.status(400).json({ error: err });
  if (db.tasks.filter((t) => t.user_id === req.user.id).length >= MAX_TASKS_PER_USER)
    return res.status(400).json({ error: `Task limit reached (${MAX_TASKS_PER_USER}). Delete some tasks first.` });
  const b = req.body;
  const task = { id: ++db.seq.task, user_id: req.user.id, title: b.title.trim(), description: b.description || '',
    status: b.status || 'todo', priority: b.priority || 'medium', due_date: b.due_date || null, created_at: now(), updated_at: now() };
  db.tasks.push(task); tasksById.set(task.id, task); save(); broadcast('created', task);
  res.status(201).json(view(task));
});

app.put('/api/tasks/:id', auth, (req, res) => {
  const task = tasksById.get(+req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found.' });
  if (!canAccess(req.user, task)) return res.status(403).json({ error: 'Not allowed.' });
  const err = validate(req.body, true);
  if (err) return res.status(400).json({ error: err });
  for (const k of ['title', 'description', 'status', 'priority', 'due_date'])
    if (req.body[k] !== undefined) task[k] = k === 'title' ? String(req.body[k]).trim() : (req.body[k] || (k === 'due_date' ? null : ''));
  task.updated_at = now(); save(); broadcast('updated', task);
  res.json(view(task));
});

app.delete('/api/tasks/:id', auth, (req, res) => {
  const task = tasksById.get(+req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found.' });
  if (!canAccess(req.user, task)) return res.status(403).json({ error: 'Not allowed.' });
  db.tasks.splice(db.tasks.indexOf(task), 1); tasksById.delete(task.id); save(); broadcast('deleted', task);
  res.json({ ok: true });
});

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));
app.use((err, req, res, next) => res.status(err.status || 500).json({ error: err.status === 400 ? 'Invalid request body.' : 'Server error.' }));

// ---------- Real-time (WebSockets): sends the changed task itself, so clients never re-download the list ----------
const server = http.createServer(app);
const wss = new WebSocketServer({ server, maxPayload: 1024 });
wss.on('connection', (ws, req) => {
  try {
    const p = jwt.verify(new URL(req.url, 'http://x').searchParams.get('token'), SECRET);
    const u = usersById.get(p.id);
    if (!u) throw new Error('gone');
    ws.user = { id: u.id, role: u.role };
  } catch { return ws.close(4001, 'unauthorized'); }
  ws.alive = true;
  ws.on('pong', () => { ws.alive = true; });
});
setInterval(() => wss.clients.forEach((c) => { if (!c.alive) return c.terminate(); c.alive = false; c.ping(); }), 30000).unref();
function broadcast(type, task) {
  const msg = JSON.stringify(type === 'deleted' ? { type, id: task.id } : { type, task: view(task) });
  wss.clients.forEach((c) => {
    if (c.readyState === 1 && c.user && (c.user.role === 'admin' || c.user.id === task.user_id)) c.send(msg);
  });
}

server.on('error', (e) => {
  console.error(e.code === 'EADDRINUSE' ? `Port ${PORT} is busy. Windows: set PORT=3001 && npm start   Mac/Linux: PORT=3001 npm start` : e);
  process.exit(1);
});
server.listen(PORT, () => console.log(`Task Manager running at http://localhost:${PORT}`));
