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

// ── STOPS: get raw data for date range filtering ──────────────────────────────
const STOPS_RAW_FILE = path.join(__dirname, 'data', 'stops_raw.json');

app.get('/api/stops/meta', (req, res) => {
  try {
    const raw = JSON.parse(fs.readFileSync(STOPS_RAW_FILE, 'utf8'));
    res.json({ min_date: raw.min_date, max_date: raw.max_date,
               points: [...new Set(raw.rows.map(r => r.pt))].sort() });
  } catch { res.json({ min_date: null, max_date: null, points: [] }); }
});

app.get('/api/stops/range', (req, res) => {
  if (!checkView(req, res)) return;
  try {
    const { from, to } = req.query;
    if (!from || !to) return res.status(400).json({ error: 'from и to обязательны' });
    const raw = JSON.parse(fs.readFileSync(STOPS_RAW_FILE, 'utf8'));
    const rows = raw.rows.filter(r => r.d >= from && r.d <= to);
    res.json(aggregateStops(rows, `${formatDate(from)} — ${formatDate(to)}`));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/stops/upload', (req, res) => {
  if (!checkAdmin(req, res)) return;
  try {
    const data = req.body;
    if (!data.rows || !data.min_date) return res.status(400).json({ error: 'Неверный формат' });
    // Merge rows
    let existing = { rows: [], min_date: data.min_date, max_date: data.max_date };
    try { existing = JSON.parse(fs.readFileSync(STOPS_RAW_FILE, 'utf8')); } catch {}
    // Remove rows in same date range, add new ones
    const filtered = existing.rows.filter(r => r.d < data.min_date || r.d > data.max_date);
    const merged   = [...filtered, ...data.rows].sort((a,b) => a.d.localeCompare(b.d));
    const result   = { rows: merged,
      min_date: merged[0]?.d || data.min_date,
      max_date: merged[merged.length-1]?.d || data.max_date };
    fs.writeFileSync(STOPS_RAW_FILE, JSON.stringify(result));
    res.json({ ok: true, total_rows: merged.length, min_date: result.min_date, max_date: result.max_date });
  } catch(e) { res.status(400).json({ error: e.message }); }
});

function formatDate(d) {
  const [y,m,day] = d.split('-');
  return `${day}.${m}.${y}`;
}

function aggregateStops(rows, period) {
  if (!rows.length) return { period, total_stops: 0, total_points: 0,
    total_products: 0, avg_duration: 0, by_date: [], all_points: [],
    active: [], by_point: [], top_products: [] };

  const DOW = ['Вс','Пн','Вт','Ср','Чт','Пт','Сб'];
  const byDate = {}, byPoint = {}, byProduct = {};

  rows.forEach(r => {
    // by date
    if (!byDate[r.d]) byDate[r.d] = 0;
    byDate[r.d]++;
    // by point
    if (!byPoint[r.pt]) byPoint[r.pt] = { count:0, dur:0, products:{} };
    byPoint[r.pt].count++;
    byPoint[r.pt].dur += r.mn;
    byPoint[r.pt].products[r.pr] = (byPoint[r.pt].products[r.pr]||0)+1;
    // by product
    if (!byProduct[r.pr]) byProduct[r.pr] = { count:0, dur:0, points: new Set() };
    byProduct[r.pr].count++;
    byProduct[r.pr].dur += r.mn;
    byProduct[r.pr].points.add(r.pt);
  });

  const by_date = Object.entries(byDate).sort().map(([d,c]) => {
    const dt = new Date(d);
    return { date: formatDate(d), dow: DOW[dt.getDay()], count: c };
  });

  const by_point = Object.entries(byPoint)
    .map(([name,v]) => ({
      name, count: v.count,
      avg_dur: Math.round(v.dur / v.count),
      total_dur: v.dur,
      top_products: Object.entries(v.products).sort((a,b)=>b[1]-a[1]).slice(0,5).map(x=>x[0])
    })).sort((a,b) => b.count - a.count);

  const top_products = Object.entries(byProduct)
    .map(([name,v]) => ({
      name, count: v.count,
      avg_dur: Math.round(v.dur / v.count),
      points: [...v.points].slice(0,5)
    })).sort((a,b) => b.count - a.count).slice(0,20);

  const active = rows.filter(r => !r.rm).map(r => ({
    point: r.pt, product: r.pr, since: r.ad, dur: r.mn
  })).slice(0, 200);

  const totalDur = rows.reduce((s,r) => s+r.mn, 0);

  return {
    period, total_stops: rows.length,
    total_points: Object.keys(byPoint).length,
    total_products: Object.keys(byProduct).length,
    avg_duration: rows.length ? Math.round(totalDur / rows.length) : 0,
    by_date, all_points: Object.keys(byPoint).sort(),
    active, by_point, top_products
  };
}
