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

// ── GET writeoffs_by_point ────────────────────────────────────────────────────
app.get('/api/data/writeoffs_by_point', async (req, res) => {
  if (!checkView(req, res)) return;
  try {
    const localPath = path.join(LOCAL_DATA_DIR, 'writeoffs_by_point.json');
    if (fs.existsSync(localPath)) {
      return res.json(JSON.parse(fs.readFileSync(localPath, 'utf8')));
    }
    res.json(null);
  } catch(e) { res.json(null); }
});

app.post('/api/sebes', upload.single('file'), async (req, res) => {
  if (!checkAdmin(req, res)) return;
  try {
    const incoming = JSON.parse(req.file ? req.file.buffer.toString() : req.body.data);
    if (!incoming.meta || !incoming.all_items) return res.status(400).json({ error: 'Неверный формат' });

    const mode = req.query.mode || 'replace'; // replace | merge
    const { data: existing, sha } = await readSebes();

    let finalData = incoming;

    if (mode === 'merge' && existing && existing.meta && existing.all_items) {
      finalData = mergeSebesPeriods(existing, incoming);
    }

    const dest = await writeSebes(finalData, sha);
    res.json({
      ok: true,
      items: finalData.all_items.length,
      periods: finalData.meta.periods,
      mode,
      saved_to: dest
    });
  } catch(e) { res.status(400).json({ error: e.message }); }
});

// Объединяем два sebes JSON — добавляем новый период к истории
function mergeSebesPeriods(existing, incoming) {
  const norm = s => String(s).substring(0,40).trim().toLowerCase();

  // Все периоды из нового файла которых ещё нет в текущем
  const existPeriods = existing.meta.periods || [];
  const newPeriods   = incoming.meta.periods || [];
  const addPeriods   = newPeriods.filter(p => !existPeriods.includes(p));

  if (!addPeriods.length) {
    // Нет новых периодов — просто заменяем
    return incoming;
  }

  // Строим карту существующих позиций
  const existMap = {};
  existing.all_items.forEach(it => { existMap[norm(it.name)] = it; });

  // Строим карту новых позиций — только для добавляемых периодов
  const incomingMap = {};
  incoming.all_items.forEach(it => { incomingMap[norm(it.name)] = it; });

  // Объединяем
  const allKeys = new Set([...Object.keys(existMap), ...Object.keys(incomingMap)]);
  const merged = [];

  allKeys.forEach(key => {
    const ex  = existMap[key];
    const inc = incomingMap[key];

    if (!ex && inc) { merged.push(inc); return; }
    if (ex && !inc) { merged.push(ex); return; }

    // Есть в обоих — объединяем историю
    const exHistory  = ex.history  || [];
    const incHistory = inc.history || [];

    // Добавляем только новые периоды из incoming
    const existHistPeriods = new Set(exHistory.map(h => h.period));
    const newHistEntries   = incHistory.filter(h => !existHistPeriods.has(h.period));
    const fullHistory      = [...exHistory, ...newHistEntries];

    // Пересчитываем diff: предпоследний → последний
    const costs = fullHistory.filter(h => h.cost).map(h => h.cost);
    const diff     = costs.length >= 2 ? Math.round((costs[costs.length-1]-costs[costs.length-2])*100)/100 : null;
    const diff_pct = costs.length >= 2 && costs[costs.length-2]
      ? Math.round((costs[costs.length-1]-costs[costs.length-2])/costs[costs.length-2]*10000)/100 : null;

    const totalDiff    = costs.length >= 2 ? Math.round((costs[costs.length-1]-costs[0])*100)/100 : null;
    const totalDiffPct = costs.length >= 2 && costs[0]
      ? Math.round((costs[costs.length-1]-costs[0])/costs[0]*10000)/100 : null;

    const trend = diff === null ? 'same' : diff > 0 ? 'up' : diff < 0 ? 'down' : 'same';

    merged.push({
      ...ex,
      cost:      costs[costs.length-1] || ex.cost,
      cost_old:  costs.length >= 2 ? costs[costs.length-2] : ex.cost_old,
      diff, diff_pct,
      total_diff: totalDiff, total_diff_pct: totalDiffPct,
      history: fullHistory, trend,
    });
  });

  merged.sort((a,b) => a.name.localeCompare(b.name, 'ru'));

  // Пересчитываем топы
  const topGrowth = merged.filter(i=>i.diff&&i.diff>0).sort((a,b)=>b.diff_pct-a.diff_pct).slice(0,15);
  const topDrop   = merged.filter(i=>i.diff&&i.diff<0).sort((a,b)=>a.diff_pct-b.diff_pct).slice(0,15);
  const allCats   = [...new Set(merged.map(i=>i.cat).filter(Boolean))].sort();

  const allPeriods = [...existPeriods, ...addPeriods];

  return {
    meta: {
      ...existing.meta,
      periods:      allPeriods,
      total_items:  merged.length,
      total_cats:   allCats.length,
      with_history: merged.filter(i=>i.history&&i.history.length>1).length,
      growth_count: topGrowth.length,
      drop_count:   topDrop.length,
      all_cats:     allCats,
    },
    top_growth: topGrowth,
    top_drop:   topDrop,
    top_margin: [],
    low_margin: [],
    all_items:  merged,
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// XLSX PARSERS
// ══════════════════════════════════════════════════════════════════════════════
let XLSX_LIB = null;
function getXlsx() {
  if (!XLSX_LIB) XLSX_LIB = require('xlsx');
  return XLSX_LIB;
}

// ── Стопы из XLSX ─────────────────────────────────────────────────────────────
function parseStopsXlsx(buffer) {
  const XLSX = getXlsx();
  const wb = XLSX.read(buffer, { type:'buffer', cellDates:true });
  const sheet = wb.Sheets['СТОПЫ'] || wb.Sheets[wb.SheetNames[0]];
  const rows  = XLSX.utils.sheet_to_json(sheet, { header:1, defval:null });

  // Находим строку-заголовок (содержит "Точка" или "Наименование")
  let dataStart = 0;
  for (let i = 0; i < Math.min(rows.length, 5); i++) {
    const r = rows[i].map(v => String(v||'').toLowerCase());
    if (r.some(v => v.includes('точк') || v.includes('наимен'))) { dataStart = i+1; break; }
  }

  const DOW = ['Вс','Пн','Вт','Ср','Чт','Пт','Сб'];
  const fmtD = d => { const [y,m,day]=d.split('-'); return `${day}.${m}.${y}`; };
  const dow  = d => DOW[(new Date(d).getDay())];

  function parseDur(v) {
    if (!v) return 0;
    const s = String(v).trim();
    let m = s.match(/^(\d+):(\d+):(\d+)$/);
    if (m) return +m[1]*60 + +m[2];
    m = s.match(/^(\d+):(\d+)$/);
    if (m) return +m[1]*60 + +m[2];
    // Excel может хранить время как дробь суток
    if (!isNaN(+v)) return Math.round(+v * 24 * 60);
    return 0;
  }

  function parseDate(v) {
    if (!v) return null;
    if (v instanceof Date && !isNaN(v)) return v;
    const d = new Date(v);
    return isNaN(d) ? null : d;
  }

  function fmtTs(d) { return d ? d.toISOString().replace('T',' ').slice(0,19).replace(' ','T') : null; }
  function fmtDay(d) { return d ? d.toISOString().slice(0,10) : null; }

  const rowsList = [];
  for (let i = dataStart; i < rows.length; i++) {
    const r = rows[i];
    const pt = String(r[0]||'').trim();
    const pr = String(r[1]||'').trim();
    if (!pt || pt === 'nan' || !pr) continue;
    const addedTs   = parseDate(r[2]);
    const removedTs = parseDate(r[3]);
    const mn        = parseDur(r[4]);
    if (!addedTs) continue;
    rowsList.push({ d: fmtDay(addedTs), pt, pr, ad: fmtTs(addedTs), rm: fmtTs(removedTs), mn });
  }

  if (!rowsList.length) throw new Error('Не найдено строк стопов. Проверьте лист «СТОПЫ» и колонки: Точка, Продукт, Добавлен, Снят, Длительность');

  // Группируем и сжимаем
  const byDay = {};
  rowsList.forEach(r => { (byDay[r.d] = byDay[r.d]||[]).push(r); });

  const DOW2 = ['Вс','Пн','Вт','Ср','Чт','Пт','Сб'];
  function compress(rows, label) {
    const byDate={}, byPt={}, byProd={};
    rows.forEach(r => {
      byDate[r.d] = (byDate[r.d]||0)+1;
      if (!byPt[r.pt])   byPt[r.pt]   = {n:0,dur:0,prods:{}};
      if (!byProd[r.pr]) byProd[r.pr] = {n:0,dur:0,pts:new Set()};
      byPt[r.pt].n++; byPt[r.pt].dur += r.mn;
      byPt[r.pt].prods[r.pr] = (byPt[r.pt].prods[r.pr]||0)+1;
      byProd[r.pr].n++; byProd[r.pr].dur += r.mn;
      byProd[r.pr].pts.add(r.pt);
    });
    const tot = rows.reduce((s,r)=>s+r.mn,0);
    return {
      p: label, n: rows.length, pts: Object.keys(byPt).length,
      prods: Object.keys(byProd).length,
      avg: rows.length ? Math.round(tot/rows.length) : 0,
      dates: Object.entries(byDate).sort().map(([d,n])=>({d:fmtD(d),dow:dow(d),n})),
      all_pts: Object.keys(byPt).sort(),
      active: rows.filter(r=>!r.rm).slice(0,200).map(r=>({pt:r.pt,pr:r.pr,s:r.ad,d:r.mn})),
      by_pt: Object.entries(byPt).sort((a,b)=>b[1].n-a[1].n).map(([name,v])=>({
        name, n:v.n, avg:v.n?Math.round(v.dur/v.n):0, tot:v.dur,
        top:Object.entries(v.prods).sort((a,b)=>b[1]-a[1]).slice(0,5).map(([k])=>k)
      })),
      top: Object.entries(byProd).sort((a,b)=>b[1].n-a[1].n).slice(0,20).map(([name,v])=>({
        name, n:v.n, avg:v.n?Math.round(v.dur/v.n):0, pts:[...v.pts].slice(0,5)
      })),
    };
  }

  const dates = Object.keys(byDay).sort();
  const allDays = {};
  const allDates = [];
  dates.forEach(d => {
    allDays[d] = compress(byDay[d], fmtD(d));
    allDates.push({iso:d, d:fmtD(d), dow:dow(d), n:byDay[d].length});
  });

  const allPoints = [...new Set(rowsList.map(r=>r.pt))].sort();
  const fullPeriod = compress(rowsList, `${fmtD(dates[0])} — ${fmtD(dates[dates.length-1])}`);

  return {
    meta: {
      created_at: new Date().toISOString().slice(0,10),
      date_from: dates[0], date_to: dates[dates.length-1],
      total_rows: rowsList.length, total_points: allPoints.length,
      all_dates: allDates, all_points: allPoints, all_pts: allPoints,
    },
    days: allDays,
    periods: [fullPeriod],
  };
}

// ── Себестоимость из XLSX ─────────────────────────────────────────────────────
function parseSebesXlsx(buffer, periodLabel) {
  const XLSX = getXlsx();
  const wb   = XLSX.read(buffer, { type:'buffer' });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows  = XLSX.utils.sheet_to_json(sheet, { header:1, defval:null });

  // Находим заголовочную строку
  let hRow = 0;
  for (let i = 0; i < Math.min(rows.length,5); i++) {
    const r = rows[i].map(v=>String(v||'').toLowerCase());
    if (r.some(v=>v.includes('номенкл')||v.includes('наимен'))) { hRow = i; break; }
  }
  const headers = rows[hRow].map(v=>String(v||'').toLowerCase());
  const idxName = headers.findIndex(h=>h.includes('номенкл')||h.includes('наимен'));
  const idxCat  = headers.findIndex(h=>h.includes('катег'));
  const idxCost = headers.findIndex(h=>h.includes('стоим')||h.includes('себест')||h.includes('цена'));

  if (idxName < 0 || idxCost < 0) throw new Error('Не найдены колонки «Номенклатура» и «Стоимость» в файле себестоимости');

  const SKIP = new Set(['итого','','nan']);
  const nameUnitRe = /^(.+?),\s*(порц|шт|л|кг|мл|г)\.?\s*$/i;
  const label = periodLabel || new Date().toLocaleDateString('ru-RU',{month:'long',year:'numeric'});
  const items = [];

  for (let i = hRow+1; i < rows.length; i++) {
    const r = rows[i];
    const raw  = String(r[idxName]||'').trim();
    if (!raw || SKIP.has(raw.toLowerCase())) continue;
    const costRaw = r[idxCost];
    const cost = costRaw !== null && !isNaN(+costRaw) ? Math.round(+costRaw*100)/100 : null;
    const cat  = idxCat >= 0 ? String(r[idxCat]||'').trim() : 'Прочее';
    const m    = raw.match(nameUnitRe);
    const name = m ? m[1].trim() : raw;
    const unit = m ? m[2] : 'порц';
    items.push({ name, cat: cat||'Прочее', unit, cost, price:null, markup:null,
                 trend:'same', diff:null, diff_pct:null, total_diff:null, total_diff_pct:null,
                 history: cost !== null ? [{period:label, cost}] : [] });
  }

  if (!items.length) throw new Error('Не найдено позиций себестоимости');

  const allCats = [...new Set(items.map(i=>i.cat).filter(Boolean))].sort();
  return {
    meta: {
      source:'Себестоимость блюд', periods:[label],
      total_items:items.length, total_cats:allCats.length,
      with_history:0, growth_count:0, drop_count:0,
      all_cats:allCats, avg_markup:null,
      no_cost: items.filter(i=>!i.cost).length,
      created_at: new Date().toISOString().slice(0,10),
    },
    top_growth:[], top_drop:[], top_margin:[], low_margin:[],
    all_items: items,
  };
}

// ── Списания из XLSX ──────────────────────────────────────────────────────────
function parseWriteoffsXlsx(buffer, periodLabel) {
  const XLSX = getXlsx();
  const wb   = XLSX.read(buffer, { type:'buffer' });
  const sheetName = wb.SheetNames.find(n=>n.toLowerCase().includes('лист')) || wb.SheetNames[0];
  const sheet = wb.Sheets[sheetName];
  const rows  = XLSX.utils.sheet_to_json(sheet, { header:1, defval:null });

  // Известные имена складов (суффикс «склад» или точное совпадение)
  const WH_EXACT = new Set(['Склад','Склад основной','Цех пекарня склад',
    'Цех производство (склад)','Третья Рабочая (Склад)',
    'Сафари-парк (Шкотово) склад','Пожарная академия о. Русский склад']);

  const isWh = s => WH_EXACT.has(s) || /склад$/i.test(s) || /\(склад\)$/i.test(s);

  const WRITEOFF_DOC = /^Списание запасов \d+ от [\d.]+,\s*.+/i;
  const SALES_DOC    = /^Отчет о розничных продажах/i;
  const SKIP_NAMES   = new Set(['','nan','Итого','Номенклатура','Хозяйственная операция',
    'Вид деятельности','Покупатель','Документ движения, Корреспонденция','Склад']);
  const ITEM_CODE    = /^\d{3,4}[а-яс]\s/i;

  const byWh = {};
  let curWh = null, inWriteoffs = false;

  for (const row of rows) {
    const col0 = String(row[0]||'').trim();
    let cost = null;
    // col5 — себестоимость, col7 — выручка
    if (row[5] !== null && row[5] !== undefined && !isNaN(+row[5])) cost = +row[5];

    if (isWh(col0)) {
      curWh = col0; inWriteoffs = false;
      if (!byWh[curWh]) byWh[curWh] = {total:0, items:{}, cats:{}};
      continue;
    }
    if (col0 === 'Списание запасов')    { inWriteoffs = true;  continue; }
    if (SALES_DOC.test(col0))           { inWriteoffs = false; continue; }
    if (!curWh || !inWriteoffs)         continue;
    if (!cost || cost <= 0)             continue;
    if (SKIP_NAMES.has(col0))           continue;
    if (WRITEOFF_DOC.test(col0))        continue;

    const cat = (() => {
      const n = col0.toLowerCase();
      if (/кофе|молоко|сок|чай|сироп/.test(n))        return 'Напитки/Бар';
      if (/курица|свинина|говяж|бедро|филе|мясо/.test(n)) return 'Мясо/Птица';
      if (/огурц|помидор|лимон|капуст|салат|банан/.test(n)) return 'Овощи/Фрукты';
      if (/булочка|лаваш|тортилья|хлеб/.test(n))      return 'Выпечка';
      if (/соус|майонез/.test(n))                      return 'Соусы';
      if (/пакет|салфетк|пергамент|бумажн/.test(n))   return 'Расходники';
      if (/десерт|тирамис|мороженое|желе/.test(n))     return 'Десерты';
      if (/^тсп |^п\/ф /.test(n))                      return 'Полуфабрикаты';
      return 'Прочее';
    })();

    byWh[curWh].total += cost;
    byWh[curWh].cats[cat] = (byWh[curWh].cats[cat]||0) + cost;
    if (!byWh[curWh].items[col0]) byWh[curWh].items[col0] = {cost:0, qty:0};
    byWh[curWh].items[col0].cost += cost;
  }

  const grand = Object.values(byWh).reduce((s,v)=>s+v.total, 0);
  if (!grand) throw new Error('Не удалось найти данные списаний. Проверьте структуру файла.');

  const label = periodLabel || new Date().toLocaleDateString('ru-RU',{month:'long',year:'numeric'});
  const warehouses = Object.entries(byWh)
    .filter(([,v])=>v.total>0)
    .sort((a,b)=>b[1].total-a[1].total)
    .map(([name,v]) => {
      const top10 = Object.entries(v.items).sort((a,b)=>b[1].cost-a[1].cost).slice(0,10)
        .map(([nm,i])=>({name:nm, cost:Math.round(i.cost), qty:Math.round(i.qty*100)/100}));
      return {
        name, total:Math.round(v.total),
        pct: Math.round(v.total/grand*1000)/10,
        n_items: Object.keys(v.items).length,
        cats: Object.fromEntries(Object.entries(v.cats).map(([k,vv])=>[k,Math.round(vv)])),
        top3: top10.slice(0,3), top10,
      };
    });

  return { period: label, grand_total: Math.round(grand), warehouses };
}

// ── XLSX upload endpoints ─────────────────────────────────────────────────────
app.post('/api/stops/xlsx', upload.single('file'), async (req, res) => {
  if (!checkAdmin(req, res)) return;
  try {
    const data = parseStopsXlsx(req.file.buffer);
    const { sha } = await readStops();
    const dest = await writeStops(data, sha);
    res.json({ ok:true, days:Object.keys(data.days).length, periods:data.periods.length, saved_to:dest });
  } catch(e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/sebes/xlsx', upload.single('file'), async (req, res) => {
  if (!checkAdmin(req, res)) return;
  try {
    const period = req.query.period || '';
    const mode   = req.query.mode || 'replace';
    const incoming = parseSebesXlsx(req.file.buffer, period);
    const { data: existing, sha } = await readSebes();
    const finalData = (mode === 'merge' && existing && existing.meta && existing.all_items)
      ? mergeSebesPeriods(existing, incoming) : incoming;
    const dest = await writeSebes(finalData, sha);
    res.json({ ok:true, items:finalData.all_items.length, periods:finalData.meta.periods, mode, saved_to:dest });
  } catch(e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/writeoffs/xlsx', upload.single('file'), async (req, res) => {
  if (!checkAdmin(req, res)) return;
  try {
    const period = req.query.period || '';
    const data   = parseWriteoffsXlsx(req.file.buffer, period);
    // Сохраняем как новый период
    const existing = JSON.parse(fs.readFileSync(LOCAL_DATA_FILE, 'utf8'));
    existing.push(data);
    fs.writeFileSync(LOCAL_DATA_FILE, JSON.stringify(existing));
    rebuildWriteoffsIndex();
    if (GH_TOKEN && GH_OWNER) {
      try {
        const r = await ghRead(DATA_PATH);
        await ghWrite(DATA_PATH, existing, r?.sha, 'Add writeoffs period via xlsx');
      } catch(e) { console.error('GH write wo:', e.message); }
    }
    res.json({ ok:true, warehouses:data.warehouses.length, grand_total:data.grand_total, period:data.period });
  } catch(e) { res.status(400).json({ error: e.message }); }
});


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
