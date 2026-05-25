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
const LOCAL_STOPS_FILE = path.join(LOCAL_DATA_DIR, 'stops_raw.json');
const LOCAL_STOPS_FULL = path.join(LOCAL_DATA_DIR, 'stops_full.json');
if (!fs.existsSync(LOCAL_STOPS_FULL)) fs.writeFileSync(LOCAL_STOPS_FULL, 'null');
fs.mkdirSync(LOCAL_DATA_DIR, { recursive: true });
if (!fs.existsSync(LOCAL_DATA_FILE))  fs.writeFileSync(LOCAL_DATA_FILE,  JSON.stringify([]));
if (!fs.existsSync(LOCAL_STOPS_FILE)) fs.writeFileSync(LOCAL_STOPS_FILE, JSON.stringify({rows:[],min_date:'',max_date:''}));

// При старте — пробуем загрузить данные из GitHub если токен есть
async function initFromGitHub() {
  if (!GH_TOKEN || !GH_OWNER) {
    console.log('GitHub не настроен — данные только локальные');
    return;
  }
  console.log('Загружаем данные из GitHub...');
  const files = [
    { path: DATA_PATH,       local: LOCAL_DATA_FILE,  def: '[]' },
    { path: 'data/stops_full.json', local: path.join(LOCAL_DATA_DIR,'stops_full.json'), def: 'null' },
    { path: 'data/deliveries.json', local: path.join(LOCAL_DATA_DIR,'deliveries.json'), def: 'null' },
    { path: 'data/production.json', local: path.join(LOCAL_DATA_DIR,'production.json'), def: 'null' },
    { path: 'data/sebes.json', local: path.join(LOCAL_DATA_DIR,'sebes.json'), def: 'null' },
  ];
  for (const f of files) {
    try {
      const r = await ghRead(f.path);
      if (r && r.content) {
        fs.writeFileSync(f.local, JSON.stringify(r.content));
        console.log('✓', f.path);
      }
    } catch(e) { console.log('✗', f.path, e.message); }
  }
}

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

// ── Stops: read/write via GitHub (same pattern as periods) ──────────────────
const STOPS_FILE_PATH  = 'data/stops_full.json';

async function readStops() {
  if (GH_TOKEN && GH_OWNER) {
    try {
      const r = await ghRead(STOPS_FILE_PATH);
      if (r) {
        fs.writeFileSync(LOCAL_STOPS_FULL, JSON.stringify(r.content));
        return { data: r.content, sha: r.sha, source: 'github' };
      }
    } catch(e) { console.error('Stops GitHub read:', e.message); }
  }
  try {
    const data = JSON.parse(fs.readFileSync(LOCAL_STOPS_FULL, 'utf8'));
    return { data, sha: null, source: 'local' };
  } catch { return { data: null, sha: null, source: 'local' }; }
}

async function writeStops(data, sha) {
  fs.writeFileSync(LOCAL_STOPS_FULL, JSON.stringify(data));
  if (GH_TOKEN && GH_OWNER) {
    try {
      let currentSha = sha;
      if (!currentSha) { const r = await ghRead(STOPS_FILE_PATH); currentSha = r?.sha; }
      await ghWrite(STOPS_FILE_PATH, data, currentSha, 'Update stops data');
      return 'github';
    } catch(e) { console.error('Stops GitHub write error:', e.message); }
  }
  return 'local';
}

// GET /api/stops — return full stops JSON for frontend
app.get('/api/stops', async (req, res) => {
  if (!checkView(req, res)) return;
  const { data } = await readStops();
  if (!data) return res.json(null);
  res.json(data);
});

// POST /api/stops — upload new stops JSON (admin only)
app.post('/api/stops', upload.single('file'), async (req, res) => {
  if (!checkAdmin(req, res)) return;
  try {
    const data = JSON.parse(req.file ? req.file.buffer.toString() : req.body.data);
    if (!data.meta || !data.days || !data.periods)
      return res.status(400).json({ error: 'Неверный формат. Ожидается {meta, days, periods}' });
    const { sha } = await readStops();
    const dest = await writeStops(data, sha);
    res.json({ ok: true, days: Object.keys(data.days).length,
               periods: data.periods.length, saved_to: dest });
  } catch(e) { res.status(400).json({ error: e.message }); }
});

// ── Frontend ──────────────────────────────────────────────────────────────────

// ── Deliveries ────────────────────────────────────────────────────────────────
const DEL_FILE_PATH  = 'data/deliveries.json';
const LOCAL_DEL_FILE = path.join(LOCAL_DATA_DIR, 'deliveries.json');
if (!fs.existsSync(LOCAL_DEL_FILE)) fs.writeFileSync(LOCAL_DEL_FILE, JSON.stringify(null));

async function readDeliveries() {
  if (GH_TOKEN && GH_OWNER) {
    try {
      const r = await ghRead(DEL_FILE_PATH);
      if (r) { fs.writeFileSync(LOCAL_DEL_FILE, JSON.stringify(r.content)); return { data: r.content, sha: r.sha }; }
    } catch(e) { console.error('Del GitHub read:', e.message); }
  }
  try { return { data: JSON.parse(fs.readFileSync(LOCAL_DEL_FILE, 'utf8')), sha: null }; }
  catch { return { data: null, sha: null }; }
}

async function writeDeliveries(data, sha) {
  fs.writeFileSync(LOCAL_DEL_FILE, JSON.stringify(data));
  if (GH_TOKEN && GH_OWNER) {
    try {
      let s = sha; if (!s) { const r = await ghRead(DEL_FILE_PATH); s = r?.sha; }
      await ghWrite(DEL_FILE_PATH, data, s, 'Update deliveries');
      return 'github';
    } catch(e) { console.error('Del GitHub write:', e.message); }
  }
  return 'local';
}

app.get('/api/deliveries', async (req, res) => {
  if (!checkView(req, res)) return;
  const { data } = await readDeliveries();
  res.json(data);
});

app.post('/api/deliveries', upload.single('file'), async (req, res) => {
  if (!checkAdmin(req, res)) return;
  try {
    const data = JSON.parse(req.file ? req.file.buffer.toString() : req.body.data);
    if (!data.meta || !data.rows) return res.status(400).json({ error: 'Неверный формат' });
    const { sha } = await readDeliveries();
    const dest = await writeDeliveries(data, sha);
    res.json({ ok: true, rows: data.rows.length, saved_to: dest });
  } catch(e) { res.status(400).json({ error: e.message }); }
});

// ── Writeoffs index (by day + by warehouse) ──────────────────────────────────
const WO_INDEX_FILE = path.join(LOCAL_DATA_DIR, 'writeoffs_index.json');

app.get('/api/writeoffs/index', async (req, res) => {
  if (!checkView(req, res)) return;
  try {
    if (fs.existsSync(WO_INDEX_FILE)) {
      const data = JSON.parse(fs.readFileSync(WO_INDEX_FILE, 'utf8'));
      return res.json(data);
    }
    res.json(null);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Rebuild index after new writeoffs_raw upload
function rebuildWriteoffsIndex() {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(LOCAL_DATA_DIR,'writeoffs_raw.json'),'utf8'));
    const rows = raw.rows || [];
    const DOW = ['Вс','Пн','Вт','Ср','Чт','Пт','Сб'];
    const cat = n => {
      n = n.toLowerCase();
      if(/кофе|молоко|сок|чай|сироп/.test(n)) return 'Напитки/Бар';
      if(/курица|свинина|говяж|бедро|филе|колбас|котлет|мясо/.test(n)) return 'Мясо/Птица';
      if(/огурц|помидор|лимон|лайм|капуст|салат|банан|манго|пюре|морковь/.test(n)) return 'Овощи/Фрукты';
      if(/булочка|лаваш|тортилья|бриошь|хлеб/.test(n)) return 'Выпечка/Хлеб';
      if(/соус|майонез/.test(n)) return 'Соусы';
      if(/пакет|салфетк|пергамент|бумажн/.test(n)) return 'Упаковка';
      return 'Прочее';
    };
    const buildPeriod = (frows, label) => {
      const byWh = {};
      frows.forEach(r => {
        if (!byWh[r.wh]) byWh[r.wh] = {total:0,items:{},cats:{}};
        byWh[r.wh].total += r.cost;
        const c = cat(r.nm);
        byWh[r.wh].cats[c] = (byWh[r.wh].cats[c]||0)+r.cost;
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
          return {name,total:Math.round(v.total),
            pct:grand?Math.round(v.total/grand*1000)/10:0,
            n_items:items.length,
            cats:Object.fromEntries(Object.entries(v.cats).map(([k,vv])=>[k,Math.round(vv)])),
            top3:top10.slice(0,3),top10};
        });
      return {period:label,grand_total:Math.round(grand),warehouses};
    };
    const dates = [...new Set(rows.map(r=>r.d))].sort();
    const whs   = [...new Set(rows.map(r=>r.wh))].sort();
    const dateTotal = {}, whTotal = {};
    rows.forEach(r=>{ dateTotal[r.d]=(dateTotal[r.d]||0)+r.cost; whTotal[r.wh]=(whTotal[r.wh]||0)+r.cost; });
    const byDay = {}, byWh = {};
    dates.forEach(d=>{
      const dt = new Date(d.split('.').reverse().join('-'));
      const dow = DOW[dt.getDay()];
      const short = d.substring(0,5);
      byDay[d] = buildPeriod(rows.filter(r=>r.d===d), `${short} (${dow})`);
    });
    whs.forEach(wh=>{
      byWh[wh] = buildPeriod(rows.filter(r=>r.wh===wh), wh);
    });
    const index = {
      meta:{
        dates: dates.map(d=>({d,short:d.substring(0,5),dow:DOW[new Date(d.split('.').reverse().join('-')).getDay()],total:Math.round(dateTotal[d])})),
        warehouses: whs.sort((a,b)=>(whTotal[b]||0)-(whTotal[a]||0)).map(w=>({name:w,total:Math.round(whTotal[w]||0)}))
      },
      by_day: byDay,
      by_wh: byWh
    };
    fs.writeFileSync(WO_INDEX_FILE, JSON.stringify(index));
    console.log('Writeoffs index rebuilt:', dates.length, 'days,', whs.length, 'warehouses');
  } catch(e) { console.error('Index rebuild error:', e.message); }
}


// ── Production ────────────────────────────────────────────────────────────────
const PROD_FILE_PATH  = 'data/production.json';
const LOCAL_PROD_FILE = path.join(LOCAL_DATA_DIR, 'production.json');
if (!fs.existsSync(LOCAL_PROD_FILE)) fs.writeFileSync(LOCAL_PROD_FILE, 'null');

async function readProduction() {
  if (GH_TOKEN && GH_OWNER) {
    try {
      const r = await ghRead(PROD_FILE_PATH);
      if (r) { fs.writeFileSync(LOCAL_PROD_FILE, JSON.stringify(r.content)); return { data: r.content, sha: r.sha }; }
    } catch(e) { console.error('Prod GitHub read:', e.message); }
  }
  try { return { data: JSON.parse(fs.readFileSync(LOCAL_PROD_FILE, 'utf8')), sha: null }; }
  catch { return { data: null, sha: null }; }
}

async function writeProduction(data, sha) {
  fs.writeFileSync(LOCAL_PROD_FILE, JSON.stringify(data));
  if (GH_TOKEN && GH_OWNER) {
    try {
      let s = sha; if (!s) { const r = await ghRead(PROD_FILE_PATH); s = r?.sha; }
      await ghWrite(PROD_FILE_PATH, data, s, 'Update production');
      return 'github';
    } catch(e) { console.error('Prod GitHub write:', e.message); }
  }
  return 'local';
}

app.get('/api/production', async (req, res) => {
  if (!checkView(req, res)) return;
  const { data } = await readProduction();
  res.json(data);
});

app.post('/api/production', upload.single('file'), async (req, res) => {
  if (!checkAdmin(req, res)) return;
  try {
    const data = JSON.parse(req.file ? req.file.buffer.toString() : req.body.data);
    if (!data.meta || !data.rows) return res.status(400).json({ error: 'Неверный формат' });
    const { sha } = await readProduction();
    const dest = await writeProduction(data, sha);
    res.json({ ok: true, rows: data.rows.length, saved_to: dest });
  } catch(e) { res.status(400).json({ error: e.message }); }
});

// ── Sebes (Себестоимость) ────────────────────────────────────────────────────
const SEBES_FILE_PATH  = 'data/sebes.json';
const LOCAL_SEBES_FILE = path.join(LOCAL_DATA_DIR, 'sebes.json');
if (!fs.existsSync(LOCAL_SEBES_FILE)) fs.writeFileSync(LOCAL_SEBES_FILE, 'null');

async function readSebes() {
  if (GH_TOKEN && GH_OWNER) {
    try {
      const r = await ghRead(SEBES_FILE_PATH);
      if (r) { fs.writeFileSync(LOCAL_SEBES_FILE, JSON.stringify(r.content)); return { data: r.content, sha: r.sha }; }
    } catch(e) { console.error('Sebes GitHub read:', e.message); }
  }
  try { return { data: JSON.parse(fs.readFileSync(LOCAL_SEBES_FILE, 'utf8')), sha: null }; }
  catch { return { data: null, sha: null }; }
}

async function writeSebes(data, sha) {
  fs.writeFileSync(LOCAL_SEBES_FILE, JSON.stringify(data));
  if (GH_TOKEN && GH_OWNER) {
    try {
      let s = sha; if (!s) { const r = await ghRead(SEBES_FILE_PATH); s = r?.sha; }
      await ghWrite(SEBES_FILE_PATH, data, s, 'Update sebes');
      return 'github';
    } catch(e) { console.error('Sebes GitHub write:', e.message); }
  }
  return 'local';
}

app.get('/api/sebes', async (req, res) => {
  if (!checkView(req, res)) return;
  const { data } = await readSebes();
  res.json(data);
});

app.post('/api/sebes', upload.single('file'), async (req, res) => {
  if (!checkAdmin(req, res)) return;
  try {
    const data = JSON.parse(req.file ? req.file.buffer.toString() : req.body.data);
    if (!data.meta || !data.all_items) return res.status(400).json({ error: 'Неверный формат' });
    const { sha } = await readSebes();
    const dest = await writeSebes(data, sha);
    res.json({ ok: true, items: data.all_items.length, saved_to: dest });
  } catch(e) { res.status(400).json({ error: e.message }); }
});

// ── DELETE data endpoints ─────────────────────────────────────────────────────
const DATA_FILES = {
  wo:           { local: LOCAL_DATA_FILE,                             gh: DATA_PATH,              empty: '[]' },
  stops:        { local: path.join(LOCAL_DATA_DIR,'stops_full.json'), gh: 'data/stops_full.json', empty: 'null' },
  deliveries:   { local: path.join(LOCAL_DATA_DIR,'deliveries.json'),gh: 'data/deliveries.json', empty: 'null' },
  production:   { local: path.join(LOCAL_DATA_DIR,'production.json'),gh: 'data/production.json', empty: 'null' },
  sebes:        { local: path.join(LOCAL_DATA_DIR,'sebes.json'),      gh: 'data/sebes.json',      empty: 'null' },
};

app.delete('/api/data/:key', async (req, res) => {
  if (!checkAdmin(req, res)) return;
  const key = req.params.key;
  const file = DATA_FILES[key];
  if (!file) return res.status(400).json({ error: 'Неизвестный раздел: ' + key });
  try {
    // Очистить локальный файл
    fs.writeFileSync(file.local, file.empty);
    // Очистить в GitHub
    if (GH_TOKEN && GH_OWNER) {
      try {
        const r = await ghRead(file.gh);
        if (r && r.sha) {
          await ghWrite(file.gh, JSON.parse(file.empty), r.sha, 'Delete ' + key + ' data');
        }
      } catch(e) { console.error('GitHub delete error:', e.message); }
    }
    console.log('Deleted:', key);
    res.json({ ok: true, key });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

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

app.listen(PORT, async () => {
  console.log(`Dashboard on :${PORT} | GitHub: ${GH_OWNER?'✓':'✗'}`);
  await initFromGitHub();
  rebuildWriteoffsIndex();
});

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
