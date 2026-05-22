const express = require('express');
const multer  = require('multer');
const fs      = require('fs');
const path    = require('path');
const https   = require('https');

const app       = express();
const PORT      = process.env.PORT || 3000;
const ADMIN_PW  = process.env.ADMIN_PASSWORD || 'admin2026';
const VIEW_PW   = process.env.VIEW_PASSWORD  || 'view2026';

// GitHub storage config
const GH_TOKEN  = process.env.GH_TOKEN  || '';
const GH_OWNER  = process.env.GH_OWNER  || '';
const GH_REPO   = process.env.GH_REPO   || 'dashboard';
const GH_BRANCH = process.env.GH_BRANCH || 'main';
const DATA_PATH = 'data/periods.json';
const STOPS_PATH= 'data/stops_raw.json';

// Local cache (in-memory + local fallback)
const LOCAL_DATA_DIR  = path.join(__dirname, 'data');
const LOCAL_DATA_FILE = path.join(LOCAL_DATA_DIR, 'periods.json');
const LOCAL_STOPS_FILE= path.join(LOCAL_DATA_DIR, 'stops_raw.json');
fs.mkdirSync(LOCAL_DATA_DIR, { recursive: true });
if (!fs.existsSync(LOCAL_DATA_FILE))  fs.writeFileSync(LOCAL_DATA_FILE,  JSON.stringify([]));
if (!fs.existsSync(LOCAL_STOPS_FILE)) fs.writeFileSync(LOCAL_STOPS_FILE, JSON.stringify({rows:[],min_date:'',max_date:''}));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
app.use(express.json({ limit: '10mb' }));
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,X-Admin-Password,X-View-Password');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ── GitHub API helpers ────────────────────────────────────────────────────────
function ghRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    if (!GH_TOKEN || !GH_OWNER) return reject(new Error('GitHub не настроен'));
    const data = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: 'api.github.com',
      path: `/repos/${GH_OWNER}/${GH_REPO}/contents/${path}`,
      method,
      headers: {
        'Authorization': `token ${GH_TOKEN}`,
        'User-Agent': 'dashboard-app',
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {})
      }
    }, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode, body: raw }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function ghRead(filePath) {
  const r = await ghRequest('GET', filePath);
  if (r.status !== 200) return null;
  const content = Buffer.from(r.body.content, 'base64').toString('utf8');
  return { content: JSON.parse(content), sha: r.body.sha };
}

async function ghWrite(filePath, data, sha, message) {
  const content = Buffer.from(JSON.stringify(data, null, 2)).toString('base64');
  return ghRequest('PUT', filePath, {
    message: message || `Update ${filePath}`,
    content,
    sha,
    branch: GH_BRANCH
  });
}

// ── Read/Write with GitHub fallback to local ─────────────────────────────────
async function readPeriods() {
  // Try GitHub first
  if (GH_TOKEN && GH_OWNER) {
    try {
      const r = await ghRead(DATA_PATH);
      if (r) {
        // Update local cache
        fs.writeFileSync(LOCAL_DATA_FILE, JSON.stringify(r.content, null, 2));
        return { data: r.content, sha: r.sha, source: 'github' };
      }
    } catch(e) { console.error('GitHub read error:', e.message); }
  }
  // Local fallback
  try {
    const data = JSON.parse(fs.readFileSync(LOCAL_DATA_FILE, 'utf8'));
    return { data, sha: null, source: 'local' };
  } catch { return { data: [], sha: null, source: 'local' }; }
}

async function writePeriods(data, sha) {
  // Always write locally
  fs.writeFileSync(LOCAL_DATA_FILE, JSON.stringify(data, null, 2));
  // Try GitHub
  if (GH_TOKEN && GH_OWNER) {
    try {
      let currentSha = sha;
      if (!currentSha) {
        const r = await ghRead(DATA_PATH);
        currentSha = r?.sha;
      }
      await ghWrite(DATA_PATH, data, currentSha, `Update periods (${data.length} total)`);
      return 'github';
    } catch(e) { console.error('GitHub write error:', e.message); }
  }
  return 'local';
}

// ── Auth ──────────────────────────────────────────────────────────────────────
function checkView(req, res) {
  const pw = req.headers['x-view-password'];
  if (pw !== VIEW_PW && pw !== ADMIN_PW) { res.status(401).json({ error: 'Нет доступа' }); return false; }
  return true;
}
function checkAdmin(req, res) {
  if (req.headers['x-admin-password'] !== ADMIN_PW) { res.status(401).json({ error: 'Неверный пароль' }); return false; }
  return true;
}

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ ok: true, github: !!(GH_TOKEN && GH_OWNER) }));

// ── Auth check ────────────────────────────────────────────────────────────────
app.post('/api/auth', (req, res) => {
  const pw = req.headers['x-view-password'] || req.headers['x-admin-password'] || req.body?.password;
  if (pw === ADMIN_PW) return res.json({ ok: true, role: 'admin' });
  if (pw === VIEW_PW)  return res.json({ ok: true, role: 'viewer' });
  res.status(401).json({ ok: false });
});

// ── GET periods ───────────────────────────────────────────────────────────────
app.get('/api/periods', async (req, res) => {
  if (!checkView(req, res)) return;
  const { data } = await readPeriods();
  res.json(data);
});

// ── POST period ───────────────────────────────────────────────────────────────
app.post('/api/periods', upload.single('file'), async (req, res) => {
  if (!checkAdmin(req, res)) return;
  try {
    const newData = JSON.parse(req.file ? req.file.buffer.toString() : req.body.data);
    if (!newData.warehouses || !newData.period) return res.status(400).json({ error: 'Неверный формат' });
    const { data: periods, sha } = await readPeriods();
    const idx = periods.findIndex(p => p.period === newData.period);
    if (idx >= 0) periods[idx] = newData; else periods.unshift(newData);
    const dest = await writePeriods(periods, sha);
    res.json({ ok: true, period: newData.period, total: periods.length, saved_to: dest });
  } catch(e) { res.status(400).json({ error: e.message }); }
});

// ── DELETE period ─────────────────────────────────────────────────────────────
app.delete('/api/periods/:idx', async (req, res) => {
  if (!checkAdmin(req, res)) return;
  const { data: periods, sha } = await readPeriods();
  const i = parseInt(req.params.idx);
  if (isNaN(i) || i < 0 || i >= periods.length) return res.status(404).json({ error: 'Не найден' });
  const removed = periods.splice(i, 1)[0];
  await writePeriods(periods, sha);
  res.json({ ok: true, removed: removed.period });
});

// ── Stops range ───────────────────────────────────────────────────────────────
const STOPS_RAW_FILE = LOCAL_STOPS_FILE;

app.get('/api/stops/range', (req, res) => {
  if (!checkView(req, res)) return;
  try {
    const { from, to } = req.query;
    const raw = JSON.parse(fs.readFileSync(STOPS_RAW_FILE, 'utf8'));
    const rows = raw.rows.filter(r => r.d >= from && r.d <= to);
    res.json(aggregateStops(rows, `${fmtDate(from)} — ${fmtDate(to)}`));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Stops meta ────────────────────────────────────────────────────────────────
app.get('/api/stops/meta', (req, res) => {
  try {
    const raw = JSON.parse(fs.readFileSync(STOPS_RAW_FILE, 'utf8'));
    res.json({ min_date: raw.min_date, max_date: raw.max_date,
               points: [...new Set(raw.rows.map(r => r.pt))].sort() });
  } catch { res.json({ min_date: null, max_date: null, points: [] }); }
});

// ── Frontend ──────────────────────────────────────────────────────────────────
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ── Helpers ───────────────────────────────────────────────────────────────────
function fmtDate(d) { const [y,m,day]=d.split('-'); return `${day}.${m}.${y}`; }

function aggregateStops(rows, period) {
  if (!rows.length) return { period, total_stops:0, total_points:0, total_products:0,
    avg_duration:0, by_date:[], all_points:[], active:[], by_point:[], top_products:[] };
  const DOW=['Вс','Пн','Вт','Ср','Чт','Пт','Сб'];
  const byDate={}, byPt={}, byProd={};
  rows.forEach(r=>{
    byDate[r.d]=(byDate[r.d]||0)+1;
    if(!byPt[r.pt]) byPt[r.pt]={count:0,dur:0,prods:{}};
    byPt[r.pt].count++; byPt[r.pt].dur+=r.mn;
    byPt[r.pt].prods[r.pr]=(byPt[r.pt].prods[r.pr]||0)+1;
    if(!byProd[r.pr]) byProd[r.pr]={count:0,dur:0,pts:new Set()};
    byProd[r.pr].count++; byProd[r.pr].dur+=r.mn; byProd[r.pr].pts.add(r.pt);
  });
  const totalDur=rows.reduce((s,r)=>s+r.mn,0);
  return {
    period, total_stops:rows.length,
    total_points:Object.keys(byPt).length,
    total_products:Object.keys(byProd).length,
    avg_duration:rows.length?Math.round(totalDur/rows.length):0,
    by_date:Object.entries(byDate).sort().map(([d,c])=>{
      const dt=new Date(d); return{date:fmtDate(d),dow:DOW[dt.getDay()],count:c};
    }),
    all_points:Object.keys(byPt).sort(),
    active:rows.filter(r=>!r.rm).map(r=>({point:r.pt,product:r.pr,since:r.ad,dur:r.mn})).slice(0,200),
    by_point:Object.entries(byPt).map(([name,v])=>({
      name,count:v.count,avg_dur:Math.round(v.dur/v.count),total_dur:v.dur,
      top_products:Object.entries(v.prods).sort((a,b)=>b[1]-a[1]).slice(0,5).map(x=>x[0])
    })).sort((a,b)=>b.count-a.count),
    top_products:Object.entries(byProd).map(([name,v])=>({
      name,count:v.count,avg_dur:Math.round(v.dur/v.count),points:[...v.pts].slice(0,5)
    })).sort((a,b)=>b.count-a.count).slice(0,20)
  };
}

app.listen(PORT, () => console.log(`Dashboard on :${PORT} | GitHub: ${GH_OWNER?'✓':'✗'}`));

// ── WRITEOFFS RAW ─────────────────────────────────────────────────────────────
const WO_RAW_FILE = path.join(LOCAL_DATA_DIR, 'writeoffs_raw.json');

app.get('/api/writeoffs/dates', (req, res) => {
  if (!checkView(req, res)) return;
  try {
    const raw = JSON.parse(fs.readFileSync(WO_RAW_FILE, 'utf8'));
    const totals = {};
    raw.rows.forEach(r => { totals[r.d] = (totals[r.d]||0) + r.cost; });
    res.json(Object.entries(totals).sort().map(([d,t])=>({d, total:Math.round(t)})));
  } catch { res.json([]); }
});

app.get('/api/writeoffs/range', (req, res) => {
  if (!checkView(req, res)) return;
  try {
    const { from, to } = req.query; // dd.mm.yyyy
    const raw = JSON.parse(fs.readFileSync(WO_RAW_FILE, 'utf8'));
    const rows = raw.rows.filter(r => r.d >= from && r.d <= to);
    res.json(aggregateWriteoffs(rows, `${from} — ${to}`));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

function aggregateWriteoffs(rows, period) {
  const CAT = n => {
    n = n.toLowerCase();
    if(/кофе|молоко|сок|чай|сироп/.test(n)) return 'Напитки/Бар';
    if(/курица|свинина|говяж|бедро|филе|колбас|котлет|мясо|сосиск/.test(n)) return 'Мясо/Птица';
    if(/огурц|помидор|лимон|лайм|капуст|салат|банан|манго|айсберг|пюре|морковь/.test(n)) return 'Овощи/Фрукты';
    if(/булочка|лаваш|тортилья|бриошь|хлеб/.test(n)) return 'Выпечка/Хлеб';
    if(/соус|майонез/.test(n)) return 'Соусы';
    if(/пакет|салфетк|пергамент|бумажн|зубочист|скотч|полотенц/.test(n)) return 'Упаковка/Расходники';
    if(/тирамис|панна|сырник|медовик|мороженое|желе|варенье|десерт/.test(n)) return 'Десерты';
    if(/^тсп |^п\/ф /.test(n)) return 'Полуфабрикаты';
    return 'Прочее';
  };
  const byWh = {};
  rows.forEach(r => {
    if (!byWh[r.wh]) byWh[r.wh] = {total:0,items:{},cats:{}};
    byWh[r.wh].total += r.cost;
    const cat = CAT(r.nm);
    byWh[r.wh].cats[cat] = (byWh[r.wh].cats[cat]||0)+r.cost;
    if (!byWh[r.wh].items[r.nm]) byWh[r.wh].items[r.nm]={cost:0,qty:0,unit:r.unit};
    byWh[r.wh].items[r.nm].cost += r.cost;
    byWh[r.wh].items[r.nm].qty  += r.qty;
  });
  const grand = Object.values(byWh).reduce((s,v)=>s+v.total,0);
  const warehouses = Object.entries(byWh)
    .sort((a,b)=>b[1].total-a[1].total)
    .map(([name,v])=>{
      const items = Object.entries(v.items).sort((a,b)=>b[1].cost-a[1].cost);
      const top10 = items.slice(0,10).map(([nm,i])=>({name:nm,cost:Math.round(i.cost),qty:Math.round(i.qty*100)/100,unit:i.unit}));
      return { name, total:Math.round(v.total),
        pct: grand?Math.round(v.total/grand*1000)/10:0,
        n_items: items.length,
        cats: Object.fromEntries(Object.entries(v.cats).map(([k,vv])=>[k,Math.round(vv)])),
        top3: top10.slice(0,3), top10 };
    });
  return { period, grand_total:Math.round(grand), warehouses };
}
