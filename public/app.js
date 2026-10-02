'use strict';
const $ = (id) => document.getElementById(id);
const LABEL = { todo: 'To do', in_progress: 'In progress', done: 'Done' };
const RANK = { high: 0, medium: 1, low: 2 };
let token = localStorage.getItem('token'), user = null, mode = 'login', editId = null, ws = null, retry = 0, raf = 0, timer = 0;
const tasks = new Map(); // id -> task (updated in place by API responses and WebSocket events)

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const today = () => new Date().toISOString().slice(0, 10);
function toast(msg) { const t = $('toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), 2200); }

async function api(path, method = 'GET', body) {
  const res = await fetch('/api' + path, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && token) logout();
  if (!res.ok) throw new Error(data.error || 'Something went wrong.');
  return data;
}

// ---------- auth ----------
function setMode(m) {
  mode = m;
  $('tabLogin').classList.toggle('on', m === 'login'); $('tabReg').classList.toggle('on', m === 'register');
  $('aName').classList.toggle('hidden', m === 'login');
  $('aGo').textContent = m === 'login' ? 'Log in' : 'Create account'; $('aErr').textContent = '';
}
$('tabLogin').onclick = () => setMode('login');
$('tabReg').onclick = () => setMode('register');
async function submitAuth() {
  $('aGo').disabled = true;
  try {
    const body = { email: $('aEmail').value, password: $('aPass').value };
    if (mode === 'register') body.name = $('aName').value;
    const d = await api('/auth/' + mode, 'POST', body);
    token = d.token; localStorage.setItem('token', token); user = d.user; start();
  } catch (e) { $('aErr').textContent = e.message; }
  $('aGo').disabled = false;
}
$('aGo').onclick = submitAuth;
$('authForm').addEventListener('keydown', (e) => { if (e.key === 'Enter') submitAuth(); });
function logout() {
  token = null; user = null; localStorage.removeItem('token');
  if (ws) { ws.onclose = null; ws.close(); }
  tasks.clear(); $('app').classList.add('hidden'); $('auth').classList.remove('hidden');
}
$('logout').onclick = logout;

// ---------- data ----------
const matches = (t) => {
  const q = $('search').value.trim().toLowerCase(), s = $('fStatus').value;
  return (!s || t.status === s) && (!q || t.title.toLowerCase().includes(q) || (t.description || '').toLowerCase().includes(q));
};
const upsert = (t) => { if (matches(t)) tasks.set(t.id, t); else tasks.delete(t.id); schedule(); };
async function load() {
  const p = new URLSearchParams();
  if ($('search').value.trim()) p.set('q', $('search').value.trim());
  if ($('fStatus').value) p.set('status', $('fStatus').value);
  try { const list = await api('/tasks?' + p); tasks.clear(); list.forEach((t) => tasks.set(t.id, t)); schedule(); }
  catch (e) { toast(e.message); }
}

// ---------- rendering (batched with requestAnimationFrame) ----------
const schedule = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(render); };
function sortTasks(l) {
  const m = $('fSort').value;
  if (m === 'due') return l.sort((a, b) => (a.due_date || '9999').localeCompare(b.due_date || '9999'));
  if (m === 'priority') return l.sort((a, b) => RANK[a.priority] - RANK[b.priority]);
  return l.sort((a, b) => b.id - a.id);
}
function render() {
  const all = [...tasks.values()], d = today();
  const done = all.filter((t) => t.status === 'done').length, late = all.filter((t) => t.status !== 'done' && t.due_date && t.due_date < d).length;
  $('stats').textContent = `${all.length} tasks · ${all.length - done} open · ${done} done` + (late ? ` · ${late} overdue` : '');
  $('board').innerHTML = Object.keys(LABEL).map((s) => {
    const list = sortTasks(all.filter((t) => t.status === s));
    return `<div class="col" data-status="${s}"><h2>${LABEL[s]} <span class="count">${list.length}</span></h2>` +
      (list.map(card).join('') || '<div class="empty">Nothing here yet.</div>') + '</div>';
  }).join('');
}
function card(t) {
  const late = t.due_date && t.status !== 'done' && t.due_date < today();
  return `<div class="task ${t.priority}" draggable="true" data-id="${t.id}">
    <h3>${esc(t.title)}</h3>${t.description ? `<p>${esc(t.description)}</p>` : ''}
    <div class="meta">${t.priority} priority${t.due_date ? ` · <span class="${late ? 'late' : ''}">due ${esc(t.due_date)}</span>` : ''}${user.role === 'admin' ? ` · by ${esc(t.owner)}` : ''}</div>
    <div class="actions">
      <select data-move aria-label="Change status">${Object.keys(LABEL).map((s) => `<option value="${s}" ${s === t.status ? 'selected' : ''}>${LABEL[s]}</option>`).join('')}</select>
      <button data-act="edit">Edit</button><button data-act="del">Delete</button>
    </div></div>`;
}

// ---------- actions (event delegation: one listener, no inline handlers) ----------
async function move(id, status) {
  const t = tasks.get(id); if (!t || t.status === status) return;
  const old = t.status; t.status = status; schedule(); // optimistic update
  try { upsert(await api('/tasks/' + id, 'PUT', { status })); }
  catch (e) { t.status = old; schedule(); toast(e.message); } // roll back on failure
}
const board = $('board');
board.addEventListener('change', (e) => { const el = e.target.closest('[data-move]'); if (el) move(+el.closest('.task').dataset.id, el.value); });
board.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-act]'); if (!b) return;
  const id = +b.closest('.task').dataset.id;
  if (b.dataset.act === 'edit') {
    const t = tasks.get(id); editId = id;
    $('tTitle').value = t.title; $('tDesc').value = t.description; $('tPri').value = t.priority; $('tDue').value = t.due_date || '';
    $('tSave').textContent = 'Save changes'; $('tCancel').classList.remove('hidden'); $('tTitle').focus(); scrollTo({ top: 0, behavior: 'smooth' });
  } else if (confirm('Delete this task?')) {
    try { await api('/tasks/' + id, 'DELETE'); tasks.delete(id); schedule(); toast('Task deleted'); } catch (err) { toast(err.message); }
  }
});
board.addEventListener('dragstart', (e) => { const t = e.target.closest('.task'); if (t) e.dataTransfer.setData('text/plain', t.dataset.id); });
board.addEventListener('dragover', (e) => { const c = e.target.closest('.col'); if (c) { e.preventDefault(); c.classList.add('over'); } });
board.addEventListener('dragleave', (e) => { const c = e.target.closest('.col'); if (c && !c.contains(e.relatedTarget)) c.classList.remove('over'); });
board.addEventListener('drop', (e) => {
  const c = e.target.closest('.col'); if (!c) return;
  e.preventDefault(); c.classList.remove('over');
  move(+e.dataTransfer.getData('text/plain'), c.dataset.status);
});

function resetForm() { editId = null; $('taskForm').reset(); $('tSave').textContent = 'Add task'; $('tCancel').classList.add('hidden'); }
$('tCancel').onclick = resetForm;
$('taskForm').onsubmit = async (e) => {
  e.preventDefault();
  const body = { title: $('tTitle').value, description: $('tDesc').value, priority: $('tPri').value, due_date: $('tDue').value || null };
  $('tSave').disabled = true;
  try {
    upsert(editId ? await api('/tasks/' + editId, 'PUT', body) : await api('/tasks', 'POST', body));
    toast(editId ? 'Task updated' : 'Task added'); resetForm();
  } catch (err) { toast(err.message); }
  $('tSave').disabled = false;
};
$('search').oninput = () => { clearTimeout(timer); timer = setTimeout(load, 250); };
$('fStatus').onchange = load; $('fSort').onchange = schedule;

// ---------- real-time: apply the pushed change directly (no refetch), reconnect with backoff ----------
function connect() {
  if (!token) return;
  ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/?token=' + encodeURIComponent(token));
  ws.onopen = () => { $('live').classList.add('on'); if (retry) load(); retry = 0; };
  ws.onclose = () => { $('live').classList.remove('on'); if (token) setTimeout(connect, Math.min(1000 * 2 ** retry++, 15000)); };
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.type === 'deleted') { tasks.delete(m.id); schedule(); } else upsert(m.task);
  };
}
function start() {
  $('auth').classList.add('hidden'); $('app').classList.remove('hidden');
  $('uName').textContent = user.name + (user.role === 'admin' ? ' (admin)' : '');
  load(); connect();
}
(async () => {
  if (!token) return $('auth').classList.remove('hidden');
  try { user = (await api('/auth/me')).user; start(); } catch { logout(); }
})();
