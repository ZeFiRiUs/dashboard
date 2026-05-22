const express = require('express');
const multer  = require('multer');
const fs      = require('fs');
const path    = require('path');

const app       = express();
const PORT      = process.env.PORT || 3000;
const ADMIN_PW  = process.env.ADMIN_PASSWORD || 'admin2026';
const VIEW_PW   = process.env.VIEW_PASSWORD  || 'view2026';
const DATA_FILE = path.join(__dirname, 'data', 'periods.json');

fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, JSON.stringify([]));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

app.use(express.json());
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,X-Admin-Password,X-View-Password');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

function readPeriods() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch { return []; }
}
function writePeriods(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}
function checkView(req, res) {
  const pw = req.headers['x-view-password'];
  if (pw !== VIEW_PW && pw !== ADMIN_PW) {
    res.status(401).json({ error: 'Нет доступа' });
    return false;
  }
  return true;
}
function checkAdmin(req, res) {
  if (req.headers['x-admin-password'] !== ADMIN_PW) {
    res.status(401).json({ error: 'Неверный пароль администратора' });
    return false;
  }
  return true;
}

// ── AUTH: check viewer or admin password ─────────────────────────────────────
app.post('/api/auth', (req, res) => {
  const pw = req.headers['x-view-password'] || req.headers['x-admin-password'] || req.body?.password;
  if (pw === ADMIN_PW) return res.json({ ok: true, role: 'admin' });
  if (pw === VIEW_PW)  return res.json({ ok: true, role: 'viewer' });
  res.status(401).json({ ok: false, error: 'Неверный пароль' });
});

// ── PUBLIC: get periods (requires view password) ─────────────────────────────
app.get('/api/periods', (req, res) => {
  if (!checkView(req, res)) return;
  res.json(readPeriods());
});

// ── ADMIN: upload new period ─────────────────────────────────────────────────
app.post('/api/periods', upload.single('file'), (req, res) => {
  if (!checkAdmin(req, res)) return;
  try {
    const data = JSON.parse(req.file ? req.file.buffer.toString() : req.body.data);
    if (!data.warehouses || !data.period) return res.status(400).json({ error: 'Неверный формат JSON' });
    const periods = readPeriods();
    const idx = periods.findIndex(p => p.period === data.period);
    if (idx >= 0) periods[idx] = data;
    else periods.unshift(data);
    writePeriods(periods);
    res.json({ ok: true, period: data.period, total: periods.length });
  } catch (e) {
    res.status(400).json({ error: 'Ошибка: ' + e.message });
  }
});

// ── ADMIN: delete period ─────────────────────────────────────────────────────
app.delete('/api/periods/:idx', (req, res) => {
  if (!checkAdmin(req, res)) return;
  const periods = readPeriods();
  const i = parseInt(req.params.idx);
  if (isNaN(i) || i < 0 || i >= periods.length) return res.status(404).json({ error: 'Не найден' });
  const removed = periods.splice(i, 1)[0];
  writePeriods(periods);
  res.json({ ok: true, removed: removed.period });
});

// ── HEALTH CHECK ─────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ ok: true }));

// ── SERVE FRONTEND ───────────────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => console.log(`Dashboard on port ${PORT} | view: ${VIEW_PW} | admin: ${ADMIN_PW}`));
