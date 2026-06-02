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
const WO_RAW_FILE = path.join(LOCAL_DATA_DIR, 'writeoffs_raw.json');
fs.mkdirSync(LOCAL_DATA_DIR, { recursive: true });
if (!fs.existsSync(LOCAL_STOPS_FULL)) fs.writeFileSync(LOCAL_STOPS_FULL, 'null');
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

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
app.use(express.json({ limit: '10mb' }));
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE');
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
  const pw = req.headers['x-view-password']
           || req.headers['x-admin-password']
           || req.body?.password
           || req.body?.pw;
  if (pw === ADMIN_PW) return res.json({ ok: true, role: 'admin' });
  if (pw === VIEW_PW)  return res.json({ ok: true, role: 'viewer' });
  // Для диагностики — логируем что пришло (без самого пароля)
  console.log('Auth fail: header keys=', Object.keys(req.headers).filter(k=>k.includes('password')||k.includes('auth')), 'body keys=', Object.keys(req.body||{}));
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

    // Агрегация по статьям списания (из поля article) и группам
    const GROUP = a => {
      const s = (a||'').toLowerCase();
      if(/недостач|потери|порч|испорчен|брак|просроч/.test(s)) return 'Потери';
      if(/питание|отработка|рецептур/.test(s)) return 'Плановые';
      if(/хоз|уборк|инвентар/.test(s)) return 'Хоз.расходы';
      if(/маркетинг|реклам|дегустац|промо/.test(s)) return 'Маркетинг';
      return 'Прочее';
    };
    const articleAgg = {}, groupAgg = {};
    rows.forEach(r => {
      const art = r.article || 'Не указана';
      articleAgg[art] = (articleAgg[art]||0) + r.cost;
      const g = GROUP(art);
      groupAgg[g] = (groupAgg[g]||0) + r.cost;
    });
    // Агрегация по точкам (склад = точка) со списаниями и главной статьёй
    const pointAgg = {};
    rows.forEach(r => {
      if(!pointAgg[r.wh]) pointAgg[r.wh] = { wo_total:0, articles:{} };
      pointAgg[r.wh].wo_total += r.cost;
      const art = r.article || 'Не указана';
      pointAgg[r.wh].articles[art] = (pointAgg[r.wh].articles[art]||0) + r.cost;
    });

    const index = {
      meta:{
        dates: dates.map(d=>({d,short:d.substring(0,5),dow:DOW[new Date(d.split('.').reverse().join('-')).getDay()],total:Math.round(dateTotal[d])})),
        warehouses: whs.sort((a,b)=>(whTotal[b]||0)-(whTotal[a]||0)).map(w=>({name:w,total:Math.round(whTotal[w]||0)})),
        articles_summary: Object.entries(articleAgg).sort((a,b)=>b[1]-a[1]).map(([name,total])=>({name,total:Math.round(total)})),
        group_totals: Object.fromEntries(Object.entries(groupAgg).map(([k,v])=>[k,Math.round(v)])),
      },
      by_day: byDay,
      by_wh: byWh,
      by_point: Object.entries(pointAgg).sort((a,b)=>b[1].wo_total-a[1].wo_total).map(([name,v])=>({
        name,
        wo_total: Math.round(v.wo_total),
        sales_rev: 0,
        rev_is_placeholder: true,
        wo_rev_pct: 0,
        top_article: Object.entries(v.articles).sort((a,b)=>b[1]-a[1])[0]?.[0] || '',
        articles: Object.fromEntries(Object.entries(v.articles).map(([k,vv])=>[k,Math.round(vv)])),
      })),
    };
    fs.writeFileSync(WO_INDEX_FILE, JSON.stringify(index));
    console.log('Writeoffs index rebuilt:', dates.length, 'days,', whs.length, 'warehouses,', Object.keys(articleAgg).length, 'articles');
  } catch(e) { console.error('Index rebuild error:', e.message); }
}


// ── Списания: синхронизация с Google Sheets ──────────────────────────────────
const WRITEOFFS_SHEET_ID = '1Xn7t2kazUNEjG4ZRkc00Im4DIWLlBtZSlIPXglciLUQ';
const WO_SHEETS_FILE = path.join(LOCAL_DATA_DIR, 'writeoffs_sheets.json');
const WO_SHEETS_DEFAULT = [
  { name: '4-10',  gid: '0' },
];
let _woSheetsCache = null, _woSheetsCacheTs = 0;

function readWoSheets() {
  try {
    if (fs.existsSync(WO_SHEETS_FILE))
      return JSON.parse(fs.readFileSync(WO_SHEETS_FILE, 'utf8'));
  } catch(e) { console.error('readWoSheets:', e.message); }
  return WO_SHEETS_DEFAULT;
}
function saveWoSheets(sheets) {
  fs.writeFileSync(WO_SHEETS_FILE, JSON.stringify(sheets, null, 2));
  _woSheetsCache = null; _woSheetsCacheTs = 0;
}

// Парсер иерархической выгрузки 1С (CSV одного листа) → массив строк {d, wh, nm, unit, cost, qty, article}
function parseWriteoffsSheet(csv) {
  const lines = csv.split('\n');
  function parseLine(line) {
    const res = []; let cur = '', inQ = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') { if (inQ && line[i+1] === '"') { cur += '"'; i++; } else inQ = !inQ; }
      else if (c === ',' && !inQ) { res.push(cur); cur = ''; }
      else cur += c;
    }
    res.push(cur); return res;
  }
  const parseNum = s => {
    if (!s) return 0;
    const n = parseFloat(String(s).replace(/\s/g,'').replace(/\u00a0/g,'').replace(',','.').replace(/[^\d.]/g,''));
    return isNaN(n) ? 0 : n;
  };

  // Находим заголовочную строку с "Себестоимость", "Количество", "Убыток" чтобы определить колонки
  let colCostSum = 5, colQty = 6, colUnit = 3; // дефолты
  for (let i = 0; i < Math.min(lines.length, 15); i++) {
    const cells = parseLine(lines[i]).map(c => c.toLowerCase().trim());
    const ci = cells.findIndex(c => c === 'себестоимость');
    const qi = cells.findIndex(c => c.includes('количество'));
    const ui = cells.findIndex(c => c === 'ед.' || c === 'ед');
    if (ci >= 0 && qi >= 0) {
      colCostSum = ci; colQty = qi;
      if (ui >= 0) colUnit = ui;
      console.log(`WO parser: колонки определены — себест=${ci}, кол-во=${qi}, ед=${colUnit}`);
      break;
    }
  }

  const META_ROWS = new Set(['продажи','вид деятельности','хозяйственная операция',
    'покупатель','номенклатура','документ движения, корреспонденция','склад','',
    'себестоимость за единицу','себестоимость','количество','убыток','ед.']);
  const DOC_RE = /^списание запасов\s+\d+\s+от\s+(\d{2}\.\d{2}\.\d{4}),\s*(.+)$/i;
  const SECTION_RE = /^списание запасов\s*$/i;
  const CODE_RE = /^\d{2,4}[а-яёa-z]?\s/i;

  const rows = [];
  let curWh = null, curItem = null;

  for (let i = 0; i < lines.length; i++) {
    const cells = parseLine(lines[i]);
    const a = (cells[0] || '').trim();
    if (!a) continue;
    const aLow = a.toLowerCase();

    const unit = (cells[colUnit] || '').trim();
    const costSum = parseNum(cells[colCostSum]);
    const qty = parseNum(cells[colQty]);

    const docM = a.match(DOC_RE);
    if (docM) {
      const dateStr = docM[1];
      const article = docM[2].trim();
      if (curWh && costSum > 0) {
        rows.push({ d: dateStr, wh: curWh, nm: curItem || a, unit: unit || '', cost: costSum, qty, article });
      }
      continue;
    }

    if (META_ROWS.has(aLow)) continue;
    if (SECTION_RE.test(a)) continue;
    if (aLow === 'итого') continue;

    // Склад: заканчивается на "склад" или "(склад)"
    if (/склад\s*$/i.test(a) || /\(склад\)\s*$/i.test(a)) {
      curWh = a; curItem = null; continue;
    }

    // Позиция: код в начале или есть ед.изм
    if (CODE_RE.test(a) || unit) { curItem = a; continue; }
  }

  return rows;
}

async function discoverWoSheets() {
  const now = Date.now();
  if (_woSheetsCache && (now - _woSheetsCacheTs) < 5*60*1000) return _woSheetsCache;
  const sheets = readWoSheets();
  _woSheetsCache = sheets; _woSheetsCacheTs = now;
  return sheets;
}

// GET список листов
app.get('/api/writeoffs/sheets', (req, res) => {
  if (!checkView(req, res)) return;
  res.json({ sheets: readWoSheets() });
});

// PUT список листов (мерж)
app.put('/api/writeoffs/sheets', express.json(), (req, res) => {
  if (!checkAdmin(req, res)) return;
  try {
    const { sheets, mode } = req.body;
    if (!Array.isArray(sheets)) return res.status(400).json({ error: 'sheets must be array' });
    if (mode === 'replace') {
      saveWoSheets(sheets);
    } else {
      const existing = readWoSheets();
      const merged = [...existing];
      for (const s of sheets) if (!merged.find(e => e.name === s.name)) merged.push(s);
      saveWoSheets(merged);
    }
    res.json({ ok: true, sheets: readWoSheets() });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// DEBUG: посмотреть сырой CSV листа списаний
app.get('/api/writeoffs/debug', async (req, res) => {
  if (!checkAdmin(req, res)) return;
  try {
    const gid = req.query.gid || '0';
    const url1 = `https://docs.google.com/spreadsheets/d/${WRITEOFFS_SHEET_ID}/export?format=csv&gid=${gid}`;
    const url2 = `https://docs.google.com/spreadsheets/d/${WRITEOFFS_SHEET_ID}/gviz/tq?tqx=out:csv&gid=${gid}`;
    const attempts = [];
    let csv = null, usedUrl = null;
    for (const url of [url1, url2]) {
      try {
        const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        attempts.push({ url: url.includes('gviz') ? 'gviz' : 'export', status: r.status });
        if (r.ok && csv === null) { csv = await r.text(); usedUrl = url.includes('gviz') ? 'gviz' : 'export'; }
      } catch(e) { attempts.push({ url, error: e.message }); }
    }
    if (csv === null) return res.json({ error: 'Оба URL не сработали', attempts });
    const lines = csv.split('\n').slice(0, 30);
    const parsed = parseWriteoffsSheet(csv);
    res.json({
      used_url: usedUrl,
      attempts,
      total_lines: csv.split('\n').length,
      first_30_raw: lines,
      parsed_rows: parsed.length,
      parsed_sample: parsed.slice(0, 5),
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST синхронизация — скачать все листы, распарсить, записать writeoffs_raw.json, перестроить индекс
app.post('/api/writeoffs/sync', async (req, res) => {
  if (!checkAdmin(req, res)) return;
  try {
    _woSheetsCache = null; _woSheetsCacheTs = 0;
    const sheets = readWoSheets();
    if (!sheets.length) return res.status(400).json({ error: 'Нет листов для синхронизации' });

    let allRows = [];
    const perSheet = [];
    for (const sheet of sheets) {
      // Основной URL экспорта
      const url1 = `https://docs.google.com/spreadsheets/d/${WRITEOFFS_SHEET_ID}/export?format=csv&gid=${sheet.gid}`;
      // Альтернативный (gviz) — иногда работает когда export отдаёт 400
      const url2 = `https://docs.google.com/spreadsheets/d/${WRITEOFFS_SHEET_ID}/gviz/tq?tqx=out:csv&gid=${sheet.gid}`;

      let csv = null, lastStatus = null;
      for (const url of [url1, url2]) {
        try {
          const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
          lastStatus = r.status;
          if (r.ok) { csv = await r.text(); break; }
        } catch(e) { lastStatus = e.message; }
      }

      if (csv === null) {
        console.warn(`WO sheet ${sheet.name} (gid ${sheet.gid}) failed: ${lastStatus}`);
        perSheet.push({ name: sheet.name, gid: sheet.gid, rows: 0, error: 'HTTP ' + lastStatus });
        continue;
      }
      const rows = parseWriteoffsSheet(csv);
      perSheet.push({ name: sheet.name, gid: sheet.gid, rows: rows.length });
      allRows = allRows.concat(rows);
      console.log(`WO sheet ${sheet.name}: ${rows.length} строк`);
    }

    if (!allRows.length) return res.status(502).json({ error: 'Не удалось распарсить ни одной строки' });

    // Записываем в writeoffs_raw.json
    const allD = allRows.map(r=>r.d).sort();
    const minDate = allD[0];
    const maxDate = allD[allD.length-1];
    const uniqDates = [...new Set(allD)].sort();
    fs.writeFileSync(WO_RAW_FILE, JSON.stringify({ rows: allRows, min_date: minDate, max_date: maxDate }));
    rebuildWriteoffsIndex();
    console.log('WO sync dates:', uniqDates.join(', '));

    res.json({ ok: true, total_rows: allRows.length, sheets: perSheet, dates: uniqDates });
  } catch(e) {
    console.error('Writeoffs sync error:', e.message);
    res.status(500).json({ error: e.message });
  }
});


// ── Production (Производство) ─────────────────────────────────────────────────
const PROD_FILE_PATH   = 'data/production.json';
const LOCAL_PROD_FILE  = path.join(LOCAL_DATA_DIR, 'production.json');
const PROD_SHEET_ID    = '1aQHL9lyceepk0bBTRY9s23VZQcbHPCDX';
const PROD_GID         = '1287300396';
if (!fs.existsSync(LOCAL_PROD_FILE)) fs.writeFileSync(LOCAL_PROD_FILE, 'null');

let _prodCsvCache = null, _prodCsvCacheTs = 0;
const PROD_CSV_CACHE_TTL = 5 * 60 * 1000;

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

function parseProductionCsv(csv) {
  const parseNum = s => {
    if (!s) return 0;
    const n = parseFloat(String(s).replace(/\u00a0/g,'').replace(/\u202f/g,'').replace(/\s/g,'').replace(',','.').replace(/[^\d.]/g,''));
    return isNaN(n) ? 0 : n;
  };
  const lines = csv.split('\n');
  function parseLine(line) {
    const res=[]; let cur='',inQ=false;
    for(let i=0;i<line.length;i++){
      const c=line[i];
      if(c==='"'){if(inQ&&line[i+1]==='"'){cur+='"';i++;}else inQ=!inQ;}
      else if(c===','&&!inQ){res.push(cur.trim());cur='';}
      else cur+=c;
    }
    res.push(cur.trim()); return res;
  }
  const rows = lines.map(parseLine);
  const SKIP_DEPT = new Set(['Отделение','','ФИО']);
  const SUMMARY_HEADERS = new Set(['выпуск едениц','выпуск единиц','на ед продукции','наименование']);
  const depts = [];
  let curDept = null;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const col0=(r[0]||'').trim(), col1=(r[1]||'').trim(), col8=(r[8]||'').trim();
    if (col1==='ФИО' && col8 && !SUMMARY_HEADERS.has(col8.toLowerCase())) break;
    if (col0 && !SKIP_DEPT.has(col0)) {
      curDept = { name:col0, pay_dept:parseNum(r[7]), output_units:parseNum(r[8]), fot_per_unit:parseNum(r[9]), staff:[] };
      depts.push(curDept);
    }
    if (curDept && col1 && col1!=='-' && !SKIP_DEPT.has(col1)) {
      const hours=parseNum(r[5]), pay=parseNum(r[6]);
      if (hours>0||pay>0) curDept.staff.push({ fio:col1, hours, pay, rate:parseNum(r[4]) });
    }
  }
  let detailStart = -1;
  for (let i = 0; i < rows.length; i++) {
    const col1=(rows[i][1]||'').trim(), col8=(rows[i][8]||'').trim();
    if (col1==='ФИО' && col8 && !SUMMARY_HEADERS.has(col8.toLowerCase())) { detailStart=i; break; }
  }
  const productsByDept = {};
  let detailDept = null;
  if (detailStart >= 0) {
    for (let i = detailStart; i < rows.length; i++) {
      const r = rows[i];
      const deptMarker=(r[8]||'').trim(), prodName=(r[9]||'').trim();
      if ((r[1]||'').trim()==='ФИО' && deptMarker && !SUMMARY_HEADERS.has(deptMarker.toLowerCase())) {
        detailDept=deptMarker; if (!productsByDept[detailDept]) productsByDept[detailDept]=[]; continue;
      }
      if (detailDept && prodName && prodName!=='Наименование' && prodName!=='итог' && prodName!=='Итог') {
        productsByDept[detailDept].push({ name:prodName, unit:(r[10]||'').trim(), fact:parseNum(r[11]), hrs_per_unit:parseNum(r[13]) });
      }
    }
  }
  const normName = s => s.toLowerCase().replace(/\s+/g,' ').trim();
  const deptsResult = depts.map(d => {
    let products = productsByDept[d.name] || [];
    if (!products.length) {
      const key = normName(d.name).split(' ')[0];
      const found = Object.keys(productsByDept).find(k => normName(k).includes(key)||key.includes(normName(k).split(' ')[0]));
      if (found) products = productsByDept[found];
    }
    const totalHrs = products.reduce((s,p)=>s+p.hrs_per_unit*p.fact,0);
    const fotPerUnit = d.output_units>0 ? Math.round(d.pay_dept/d.output_units*100)/100 : 0;
    const productsWithFot = products.map(p => {
      const fot_per_unit=(p.hrs_per_unit>0&&totalHrs>0&&d.pay_dept>0)?Math.round(d.pay_dept/totalHrs*p.hrs_per_unit*100)/100:0;
      return {...p, fot_per_unit};
    });
    return { name:d.name, pay_dept:Math.round(d.pay_dept), output_units:Math.round(d.output_units*100)/100,
      fot_per_unit:fotPerUnit, staff_count:d.staff.length,
      total_hours:Math.round(d.staff.reduce((s,e)=>s+e.hours,0)*10)/10,
      staff:d.staff, products:productsWithFot, active_products:products.filter(p=>p.fact>0).length };
  });
  const totalFot=deptsResult.reduce((s,d)=>s+d.pay_dept,0);
  const totalUnits=deptsResult.reduce((s,d)=>s+d.output_units,0);
  return {
    meta:{ sheet:'Основной расчёт', created_at:new Date().toISOString().slice(0,10),
      total_fot:totalFot, total_units:Math.round(totalUnits*100)/100,
      fot_per_unit_avg:totalUnits>0?Math.round(totalFot/totalUnits*100)/100:0,
      depts_count:deptsResult.filter(d=>d.pay_dept>0||d.output_units>0).length },
    depts: deptsResult,
  };
}

app.get('/api/production', async (req, res) => {
  if (!checkView(req, res)) return;
  const { data } = await readProduction();
  res.json(data);
});

app.get('/api/production/csv', async (req, res) => {
  if (!checkView(req, res)) return;
  const now = Date.now();
  const noCache = req.query.nocache === '1';
  if (!noCache && _prodCsvCache && (now - _prodCsvCacheTs) < PROD_CSV_CACHE_TTL) {
    return res.json(_prodCsvCache);
  }
  try {
    const url = `https://docs.google.com/spreadsheets/d/${PROD_SHEET_ID}/export?format=csv&gid=${PROD_GID}`;
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!r.ok) throw new Error('Google Sheets HTTP ' + r.status);
    const csv = await r.text();
    const result = parseProductionCsv(csv);
    _prodCsvCache = result; _prodCsvCacheTs = now;
    res.json(result);
  } catch(e) {
    console.error('Production CSV fetch error:', e.message);
    if (_prodCsvCache) return res.json(_prodCsvCache);
    res.status(502).json({ error: 'Не удалось получить данные: ' + e.message });
  }
});

app.post('/api/production/sync', async (req, res) => {
  if (!checkAdmin(req, res)) return;
  try {
    _prodCsvCache = null; _prodCsvCacheTs = 0;
    const url = `https://docs.google.com/spreadsheets/d/${PROD_SHEET_ID}/export?format=csv&gid=${PROD_GID}`;
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!r.ok) throw new Error('Google Sheets HTTP ' + r.status);
    const csv = await r.text();
    const result = parseProductionCsv(csv);
    _prodCsvCache = result; _prodCsvCacheTs = Date.now();
    const { sha } = await readProduction();
    const dest = await writeProduction(result, sha);
    res.json({ ok: true, depts: result.depts.length, total_fot: result.meta.total_fot, saved_to: dest });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/production', upload.single('file'), async (req, res) => {
  if (!checkAdmin(req, res)) return;
  try {
    const data = JSON.parse(req.file ? req.file.buffer.toString() : req.body.data);
    if (!data.meta) return res.status(400).json({ error: 'Неверный формат' });
    const { sha } = await readProduction();
    const dest = await writeProduction(data, sha);
    res.json({ ok: true, saved_to: dest });
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

// ── Sebes CSV proxy (Google Sheets) ──────────────────────────────────────────
const SEBES_SHEET_ID = '1gsS8IhZvNLrPojda-3uCJM_5VtcdlQ-f4V-g9w7DYqg';
// Листы: название → gid. Ключ используется как метка периода.
// Формат названия листа: DD.MM или DD.MM.YYYY → сортируем по дате
// ── Список листов себестоимости — хранится в файле, управляется через UI ──────
const SEBES_SHEETS_FILE = path.join(LOCAL_DATA_DIR, 'sebes_sheets.json');
const SEBES_SHEETS_DEFAULT = [
  { name: '25.03', gid: '136450477' },
  { name: '25.05', gid: '0' },
  { name: '28.05', gid: '76547916' },
];
let _sebesSheetsCache = null;
let _sebesSheetsCacheTs = 0;
const SEBES_SHEETS_TTL = 5 * 60 * 1000;

function readSebesSheets() {
  try {
    if (fs.existsSync(SEBES_SHEETS_FILE))
      return JSON.parse(fs.readFileSync(SEBES_SHEETS_FILE, 'utf8'));
  } catch(e) { console.error('readSebesSheets:', e.message); }
  return SEBES_SHEETS_DEFAULT;
}

function saveSebesSheets(sheets) {
  fs.writeFileSync(SEBES_SHEETS_FILE, JSON.stringify(sheets, null, 2));
  _sebesSheetsCache = null;   // полный сброс — при следующем запросе перечитает файл
  _sebesSheetsCacheTs = 0;
}

async function discoverSebesSheets() {
  const now = Date.now();
  if (_sebesSheetsCache && (now - _sebesSheetsCacheTs) < SEBES_SHEETS_TTL) return _sebesSheetsCache;
  const sheets = readSebesSheets();
  _sebesSheetsCache = sheets; _sebesSheetsCacheTs = now;
  return sheets;
}



function parseSheetDate(name) {
  // DD.MM или DD.MM.YY или DD.MM.YYYY
  const m = name.match(/^(\d{1,2})\.(\d{1,2})(?:\.(\d{2,4}))?$/);
  if (!m) return null;
  const year = m[3] ? (m[3].length === 2 ? 2000 + +m[3] : +m[3]) : 2026;
  return new Date(year, +m[2] - 1, +m[1]);
}

function parseCsvSimple(csv) {
  const result = [];
  const lines = csv.split('\n');
  for (const line of lines) {
    const row = [];
    let cur = '', inQ = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') { if (inQ && line[i+1] === '"') { cur += '"'; i++; } else inQ = !inQ; }
      else if (c === ',' && !inQ) { row.push(cur.trim()); cur = ''; }
      else cur += c;
    }
    row.push(cur.trim());
    result.push(row);
  }
  return result;
}

function parseSebesSheet(csv, periodLabel) {
  const rows = parseCsvSimple(csv).filter(r => r.some(c => c));
  if (!rows.length) { console.warn(`Sheet ${periodLabel}: пустой CSV`); return {}; }
  const headers = rows[0].map(h => h.toLowerCase());
  console.log(`Sheet ${periodLabel}: заголовки =`, headers.slice(0,5).join(' | '));
  const iName = headers.findIndex(h => h.includes('номенкл') || h.includes('наимен'));
  // Стоимость может быть в любой колонке — ищем по нескольким паттернам
  let iCost = headers.findIndex(h => h.includes('стоим') || h.includes('себест'));
  if (iCost < 0) iCost = headers.findIndex(h => h.includes('цена'));
  // Если не нашли по имени — берём последнюю числовую колонку
  if (iCost < 0) {
    for (let ci = headers.length - 1; ci >= 0; ci--) {
      // Проверяем первые 5 строк данных на числовые значения
      const vals = rows.slice(1, 6).map(r => (r[ci]||'').replace(',','.').replace(/\s/g,''));
      if (vals.some(v => v && !isNaN(+v) && +v > 0)) { iCost = ci; break; }
    }
  }
  console.log(`Sheet ${periodLabel}: iName=${iName}, iCost=${iCost}, строк данных=${rows.length-1}`);
  if (iName < 0 || iCost < 0) { console.warn(`Sheet ${periodLabel}: не найдены колонки`); return {}; }
  const iCat = headers.findIndex(h => h.includes('катег'));
  const SKIP = new Set(['итого', '', 'nan']);
  const map = {};
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const raw = (r[iName] || '').trim();
    if (!raw || SKIP.has(raw.toLowerCase())) continue;
    const costRaw = (r[iCost] || '').replace(',', '.').replace(/\s/g, '');
    const cost = costRaw && !isNaN(+costRaw) ? Math.round(+costRaw * 100) / 100 : null;
    const cat = iCat >= 0 ? (r[iCat] || '').trim() || 'Прочее' : 'Прочее';
    const nameUnitM = raw.match(/^(.+?),\s*(порц|шт|л|кг|мл|г)\.?\s*$/i);
    const name = nameUnitM ? nameUnitM[1].trim() : raw;
    const unit = nameUnitM ? nameUnitM[2] : 'порц';
    if (name) map[name] = { cost, cat, unit, period: periodLabel };
  }
  console.log(`Sheet ${periodLabel}: распарсено ${Object.keys(map).length} позиций`);
  return map;
}

let _sebesCsvCache = null;
let _sebesCsvCacheTs = 0;
const SEBES_CSV_CACHE_TTL = 5 * 60 * 1000;

app.get('/api/sebes/csv', async (req, res) => {
  if (!checkView(req, res)) return;
  const now = Date.now();
  const noCache = req.query.nocache === '1';
  if (!noCache && _sebesCsvCache && (now - _sebesCsvCacheTs) < SEBES_CSV_CACHE_TTL) {
    return res.json(_sebesCsvCache);
  }
  try {
    // Автодискавери листов
    const allSheets = await discoverSebesSheets();

    // Берём только листы с датой в названии (DD.MM или DD.MM.YYYY), сортируем
    const sheets = allSheets
      .filter(s => parseSheetDate(s.name) !== null)
      .sort((a, b) => parseSheetDate(a.name) - parseSheetDate(b.name));

    if (!sheets.length) throw new Error('Нет листов с датой в названии (ожидается формат ДД.ММ)');
    console.log(`Sebes: загружаем ${sheets.length} листов:`, sheets.map(s => s.name).join(', '));

    // Скачиваем все листы
    const sheetData = [];
    for (const sheet of sheets) {
      const url = `https://docs.google.com/spreadsheets/d/${SEBES_SHEET_ID}/export?format=csv&gid=${sheet.gid}`;
      const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!r.ok) { console.warn(`Sheet ${sheet.name} HTTP ${r.status}`); continue; }
      const csv = await r.text();
      const map = parseSebesSheet(csv, sheet.name);
      if (Object.keys(map).length) sheetData.push({ label: sheet.name, map });
    }

    if (!sheetData.length) throw new Error('Не удалось загрузить ни одного листа');

    // Последний лист — текущий период, остальные — история
    const latest = sheetData[sheetData.length - 1];
    const allNames = new Set();
    sheetData.forEach(s => Object.keys(s.map).forEach(n => allNames.add(n)));

    const items = [];
    for (const name of allNames) {
      const latestEntry = latest.map[name];
      const cost = latestEntry ? latestEntry.cost : null;

      // История от старого к новому
      const history = sheetData
        .map(s => s.map[name] ? { period: s.label, cost: s.map[name].cost } : null)
        .filter(Boolean);

      // Diff — сравниваем последний с предпоследним
      let diff = null, diff_pct = null, trend = 'same';
      if (history.length >= 2) {
        const prev = history[history.length - 2].cost;
        const curr = history[history.length - 1].cost;
        if (prev !== null && curr !== null) {
          diff = Math.round((curr - prev) * 100) / 100;
          diff_pct = prev !== 0 ? Math.round((curr - prev) / prev * 1000) / 10 : null;
          trend = diff > 0 ? 'up' : diff < 0 ? 'down' : 'same';
        }
      }

      // Категория и единица — из последнего листа где есть позиция
      let cat = 'Прочее', unit = 'порц';
      for (let si = sheetData.length - 1; si >= 0; si--) {
        const entry = sheetData[si].map[name];
        if (entry) { cat = entry.cat || 'Прочее'; unit = entry.unit || 'порц'; break; }
      }

      items.push({ name, cat, unit, cost, price: null, markup: null,
                   trend, diff, diff_pct, total_diff: diff, total_diff_pct: diff_pct,
                   history });
    }

    // Топы
    const withDiff = items.filter(i => i.diff !== null);
    const top_growth = [...withDiff].sort((a,b) => b.diff - a.diff).slice(0, 10);
    const top_drop   = [...withDiff].sort((a,b) => a.diff - b.diff).slice(0, 10);
    const periods    = sheetData.map(s => s.label);
    const allCats    = [...new Set(items.map(i => i.cat).filter(Boolean))].sort();

    const result = {
      meta: {
        source: 'Себес парс (Google Sheets)',
        periods,
        total_items: items.length,
        total_cats: allCats.length,
        with_history: items.filter(i => i.history.length > 1).length,
        growth_count: items.filter(i => i.trend === 'up').length,
        drop_count: items.filter(i => i.trend === 'down').length,
        all_cats: allCats, avg_markup: null,
        no_cost: items.filter(i => !i.cost).length,
        created_at: new Date().toISOString().slice(0, 10),
      },
      top_growth, top_drop, top_margin: [], low_margin: [],
      all_items: items,
    };

    _sebesCsvCache = result;
    _sebesCsvCacheTs = now;
    res.json(result);
  } catch(e) {
    console.error('Sebes CSV fetch error:', e.message);
    if (_sebesCsvCache) return res.json(_sebesCsvCache);
    res.status(502).json({ error: 'Не удалось получить данные: ' + e.message });
  }
});

// ── POST /api/sebes/sync — синхронизация из Google Sheets ────────────────────
app.post('/api/sebes/sync', async (req, res) => {
  if (!checkAdmin(req, res)) return;
  try {
    // Сбрасываем кэши
    _sebesCsvCache = null;
    _sebesCsvCacheTs = 0;
    _sebesSheetsCache = null;
    _sebesSheetsCacheTs = 0;

    const allSheets = await discoverSebesSheets();
    const sheets = allSheets
      .filter(s => parseSheetDate(s.name) !== null)
      .sort((a, b) => parseSheetDate(a.name) - parseSheetDate(b.name));

    if (!sheets.length) return res.status(400).json({ error: 'Нет листов с датой в названии (формат ДД.ММ)' });

    const sheetData = [];
    for (const sheet of sheets) {
      const url = `https://docs.google.com/spreadsheets/d/${SEBES_SHEET_ID}/export?format=csv&gid=${sheet.gid}`;
      const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!r.ok) { console.warn(`Sheet ${sheet.name} HTTP ${r.status}`); continue; }
      const csv = await r.text();
      const map = parseSebesSheet(csv, sheet.name);
      if (Object.keys(map).length) sheetData.push({ label: sheet.name, map });
    }

    if (!sheetData.length) return res.status(502).json({ error: 'Не удалось загрузить данные листов' });
    console.log(`Sebes sync: загружено ${sheetData.length} листов:`, sheetData.map(s => `${s.label}(${Object.keys(s.map).length}поз)`).join(', '));

    // Строим итоговый JSON (та же логика что в GET /api/sebes/csv)
    const latest = sheetData[sheetData.length - 1];
    const allNames = new Set();
    sheetData.forEach(s => Object.keys(s.map).forEach(n => allNames.add(n)));

    const items = [];
    for (const name of allNames) {
      const latestEntry = latest.map[name];
      const cost = latestEntry ? latestEntry.cost : null;
      const history = sheetData.map(s => s.map[name] ? { period: s.label, cost: s.map[name].cost } : null).filter(Boolean);
      let diff = null, diff_pct = null, trend = 'same';
      if (history.length >= 2) {
        const prev = history[history.length - 2].cost;
        const curr = history[history.length - 1].cost;
        if (prev !== null && curr !== null) {
          diff = Math.round((curr - prev) * 100) / 100;
          diff_pct = prev !== 0 ? Math.round((curr - prev) / prev * 1000) / 10 : null;
          trend = diff > 0 ? 'up' : diff < 0 ? 'down' : 'same';
        }
      }
      let cat = 'Прочее', unit = 'порц';
      for (let si = sheetData.length - 1; si >= 0; si--) {
        const e = sheetData[si].map[name];
        if (e) { cat = e.cat || 'Прочее'; unit = e.unit || 'порц'; break; }
      }
      items.push({ name, cat, unit, cost, price: null, markup: null,
                   trend, diff, diff_pct, total_diff: diff, total_diff_pct: diff_pct, history });
    }

    const withDiff = items.filter(i => i.diff !== null && i.diff_pct !== null);
    const allCats = [...new Set(items.map(i => i.cat).filter(Boolean))].sort();
    const result = {
      meta: {
        source: 'Себес парс (Google Sheets)',
        periods: sheetData.map(s => s.label),
        total_items: items.length, total_cats: allCats.length,
        with_history: items.filter(i => i.history.length > 1).length,
        growth_count: items.filter(i => i.trend === 'up').length,
        drop_count: items.filter(i => i.trend === 'down').length,
        all_cats: allCats, avg_markup: null,
        no_cost: items.filter(i => !i.cost).length,
        created_at: new Date().toISOString().slice(0, 10),
      },
      top_growth: [...withDiff].sort((a,b) => b.diff_pct - a.diff_pct).slice(0, 10),
      top_drop:   [...withDiff].sort((a,b) => a.diff_pct - b.diff_pct).slice(0, 10),
      top_margin: [], low_margin: [], all_items: items,
    };

    // Обновляем GET-кэш тоже
    _sebesCsvCache = result;
    _sebesCsvCacheTs = Date.now();

    const { sha } = await readSebes();
    const dest = await writeSebes(result, sha);

    res.json({ ok: true, sheets: sheetData.length, periods: result.meta.periods,
               items: items.length, saved_to: dest });
  } catch(e) {
    console.error('Sebes sync error:', e.message);
    res.status(500).json({ error: e.message });
  }
});


app.get('/api/sebes/sheets', async (req, res) => {
  if (!checkView(req, res)) return;
  try {
    const sheets = await discoverSebesSheets();
    const dated = sheets.filter(s => parseSheetDate(s.name) !== null)
                        .sort((a,b) => parseSheetDate(a.name) - parseSheetDate(b.name));
    res.json({ sheets: dated, all: sheets });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/sebes/sheets', express.json(), (req, res) => {
  if (!checkAdmin(req, res)) return;
  try {
    const { sheets, mode } = req.body;
    if (!Array.isArray(sheets)) return res.status(400).json({ error: 'sheets must be array' });
    // mode=replace — полная замена; иначе — мержим с существующими
    if (mode === 'replace') {
      saveSebesSheets(sheets);
    } else {
      const existing = readSebesSheets();
      const merged = [...existing];
      for (const s of sheets) {
        if (!merged.find(e => e.name === s.name)) merged.push(s);
      }
      // Сортируем по дате
      merged.sort((a, b) => {
        const da = parseSheetDate(a.name), db = parseSheetDate(b.name);
        return da && db ? da - db : 0;
      });
      saveSebesSheets(merged);
    }
    res.json({ ok: true, sheets: readSebesSheets() });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Deliveries CSV proxy (Google Sheets) ─────────────────────────────────────
const DELIVERIES_SHEET_ID = '1Rfwer4_rEocp7wPb-NLYsFbkWYkq5SVrO7mkYbCoflw';
let _delCsvCache = null;
let _delCsvCacheTs = 0;
const DEL_CSV_CACHE_TTL = 5 * 60 * 1000;

app.get('/api/deliveries/csv', async (req, res) => {
  if (!checkView(req, res)) return;
  const now = Date.now();
  const noCache = req.query.nocache === '1';
  if (!noCache && _delCsvCache && (now - _delCsvCacheTs) < DEL_CSV_CACHE_TTL) {
    return res.type('text/csv').send(_delCsvCache);
  }
  try {
    const url = `https://docs.google.com/spreadsheets/d/${DELIVERIES_SHEET_ID}/export?format=csv&gid=0`;
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!r.ok) throw new Error('Google Sheets HTTP ' + r.status);
    const csv = await r.text();
    _delCsvCache   = csv;
    _delCsvCacheTs = now;
    res.type('text/csv').send(csv);
  } catch(e) {
    console.error('Deliveries CSV fetch error:', e.message);
    if (_delCsvCache) return res.type('text/csv').send(_delCsvCache);
    res.status(502).json({ error: 'Не удалось получить данные: ' + e.message });
  }
});

// ── POST /api/deliveries/sync — синхронизация из Google Sheets ───────────────
app.post('/api/deliveries/sync', async (req, res) => {
  if (!checkAdmin(req, res)) return;
  try {
    _delCsvCache = null; _delCsvCacheTs = 0;
    const url = `https://docs.google.com/spreadsheets/d/${DELIVERIES_SHEET_ID}/export?format=csv&gid=0`;
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!r.ok) throw new Error('Google Sheets HTTP ' + r.status);
    const csv = await r.text();
    _delCsvCache = csv; _delCsvCacheTs = Date.now();
    // Парсинг CSV — те же колонки что в таблице
    const { data, rows } = parseDeliveriesCsvServer(csv);
    if (!data || !rows) return res.status(400).json({ error: 'Нет данных' });
    // Сохраняем
    const { sha } = await readDeliveries();
    const dest = await writeDeliveries(data, sha);
    res.json({ ok: true, rows: rows, saved_to: dest });
  } catch(e) {
    console.error('Deliveries sync error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

function parseDeliveriesCsvServer(csv) {
  const lines = csv.split('\n').filter(l => l.trim());
  if (lines.length < 2) return { data: null };
  function parseLine(line) {
    const res = []; let cur = '', inQ = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') { if (inQ && line[i+1] === '"') { cur += '"'; i++; } else inQ = !inQ; }
      else if (c === ',' && !inQ) { res.push(cur.trim()); cur = ''; }
      else cur += c;
    }
    res.push(cur.trim()); return res;
  }
  const headers = parseLine(lines[0]).map(h => h.toLowerCase().trim());
  const col = (patterns, fallback) => {
    const idx = headers.findIndex(h => patterns.some(p => h.includes(p)));
    return idx >= 0 ? idx : fallback;
  };
  const C = {
    date:   col(['столб','дат'], 0),
    point:  col(['точк'], 1),
    dept:   col(['подразд'], 2),
    type:   col(['довоз','добав'], 3),
    guilty: col(['фио','виновн'], 4),
    items:  col(['список','пояснен'], 5),
    reason: col(['причин'], 6),
    cost:   col(['стоим'], 7),
    reg:    col(['реестр','внесен'], 8),
  };
  const DOW = ['Вс','Пн','Вт','Ср','Чт','Пт','Сб'];
  const fmtD = d => { const [y,mo,day] = d.split('-'); return `${day}.${mo}.${y}`; };
  const parseDateStr = s => {
    if (!s) return null;
    let m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})/);
    if (m) return `${m[3]}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`;
    m = s.match(/^(\d{4}-\d{2}-\d{2})/);
    return m ? m[1] : null;
  };
  const parseCost = s => {
    if (!s) return 0;
    const n = parseFloat(s.replace(/[^\d.,]/g,'').replace(',','.'));
    return isNaN(n) ? 0 : n;
  };
  const rowsList = [], byDate = {}, allPoints = new Set();
  for (let i = 1; i < lines.length; i++) {
    const r = parseLine(lines[i]);
    const iso = parseDateStr(r[C.date] || '');
    const point = (r[C.point] || '').trim();
    if (!iso || !point) continue;
    allPoints.add(point);
    const cost = parseCost(r[C.cost] || '');
    rowsList.push({ iso, date: iso, point, dept: (r[C.dept]||'').trim(),
      type: (r[C.type]||'').trim(), guilty: (r[C.guilty]||'').trim(),
      items: (r[C.items]||'').trim(), reason: (r[C.reason]||'').trim(),
      cost, registered: (r[C.reg]||'').trim().toLowerCase().includes('внесено') });
    if (!byDate[iso]) byDate[iso] = { n: 0, cost: 0 };
    byDate[iso].n++; byDate[iso].cost += cost;
  }
  if (!rowsList.length) return { data: null };
  const dates = Object.keys(byDate).sort();
  const data = {
    meta: {
      source: 'Довозы парс (Google Sheets)',
      total: rowsList.length,
      total_cost: Math.round(rowsList.reduce((s,r)=>s+r.cost,0)),
      min: dates[0], max: dates[dates.length-1],
      all_dates: dates.map(d => ({ iso:d, d:fmtD(d), dow:DOW[new Date(d).getDay()], n:byDate[d].n, cost:Math.round(byDate[d].cost) })),
      all_points: [...allPoints].sort(),
    },
    rows: rowsList,
  };
  return { data, rows: rowsList.length };
}

// ── Stops CSV proxy (Google Sheets) ──────────────────────────────────────────
const STOPS_SHEET_ID = '1ew1ZCPFCCDOPbC1Jk0vv9_1yvftH_0mxlO9v2oRGTiY';
let _stopsCsvCache = null;
let _stopsCsvCacheTs = 0;
const STOPS_CSV_CACHE_TTL = 5 * 60 * 1000;

app.get('/api/stops/csv', async (req, res) => {
  if (!checkView(req, res)) return;
  const now = Date.now();
  const noCache = req.query.nocache === '1';
  if (!noCache && _stopsCsvCache && (now - _stopsCsvCacheTs) < STOPS_CSV_CACHE_TTL) {
    return res.type('text/csv').send(_stopsCsvCache);
  }
  try {
    const url = `https://docs.google.com/spreadsheets/d/${STOPS_SHEET_ID}/export?format=csv&gid=0`;
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!r.ok) throw new Error('Google Sheets HTTP ' + r.status);
    const csv = await r.text();
    _stopsCsvCache   = csv;
    _stopsCsvCacheTs = now;
    res.type('text/csv').send(csv);
  } catch(e) {
    console.error('Stops CSV fetch error:', e.message);
    if (_stopsCsvCache) return res.type('text/csv').send(_stopsCsvCache);
    res.status(502).json({ error: 'Не удалось получить данные: ' + e.message });
  }
});

// ── Supply CSV proxy (Google Sheets) ─────────────────────────────────────────
const SUPPLY_SHEET_ID = '1MsTbV1p0mB3UKvweNKQnYQQZB5ou8jIAP0sFUx9hDSA';
let _supplyCache = null;
let _supplyCacheTs = 0;
const SUPPLY_CACHE_TTL = 5 * 60 * 1000;

app.get('/api/supply/csv', async (req, res) => {
  if (!checkView(req, res)) return;
  const now = Date.now();
  const noCache = req.query.nocache === '1';
  if (!noCache && _supplyCache && (now - _supplyCacheTs) < SUPPLY_CACHE_TTL) {
    return res.type('text/csv').send(_supplyCache);
  }
  try {
    const url = `https://docs.google.com/spreadsheets/d/${SUPPLY_SHEET_ID}/export?format=csv&gid=0`;
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!r.ok) throw new Error('Google Sheets HTTP ' + r.status);
    const csv = await r.text();
    _supplyCache   = csv;
    _supplyCacheTs = now;
    res.type('text/csv').send(csv);
  } catch(e) {
    console.error('Supply CSV fetch error:', e.message);
    if (_supplyCache) return res.type('text/csv').send(_supplyCache); // отдаём кэш при ошибке
    res.status(502).json({ error: 'Не удалось получить данные из Google Sheets: ' + e.message });
  }
});


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
  if (!XLSX_LIB) {
    try { XLSX_LIB = require('xlsx'); }
    catch(e) { throw new Error('Пакет xlsx не установлен. Выполните npm install на сервере.'); }
  }
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
    fs.writeFileSync(file.local, file.empty);
    // При удалении списаний — чистим также raw и индекс
    if (key === 'wo') {
      // Очищаем сырые данные (источник индекса)
      fs.writeFileSync(WO_RAW_FILE, JSON.stringify({ rows: [], min_date: null, max_date: null }));
      const indexFile = path.join(LOCAL_DATA_DIR, 'writeoffs_index.json');
      fs.writeFileSync(indexFile, JSON.stringify({ meta:{dates:[],warehouses:[]}, by_day:{}, by_wh:{}, by_point:[] }));
      // Очищаем старый статичный файл по точкам
      const byPointFile = path.join(LOCAL_DATA_DIR, 'writeoffs_by_point.json');
      if (fs.existsSync(byPointFile)) fs.writeFileSync(byPointFile, JSON.stringify({ meta:{group_totals:{},articles_summary:[]}, by_point:[] }));
      console.log('Writeoffs raw + index + by_point cleared');
    }
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

// ── Writeoffs dates & range — MUST be before the catch-all route ─────────────
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
    if (!from || !to) return res.status(400).json({ error: 'Параметры from и to обязательны' });
    const raw = JSON.parse(fs.readFileSync(WO_RAW_FILE, 'utf8'));
    const rows = raw.rows.filter(r => r.d >= from && r.d <= to);
    res.json(aggregateWriteoffs(rows, `${from} — ${to}`));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Settings (настройки дашборда) ────────────────────────────────────────────
const SETTINGS_FILE = path.join(LOCAL_DATA_DIR, 'settings.json');
const SETTINGS_DEFAULTS = { hidden_tabs: [] };

function readSettings() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) return { ...SETTINGS_DEFAULTS, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) };
  } catch(e) {}
  return { ...SETTINGS_DEFAULTS };
}
function writeSettings(data) {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(data, null, 2));
}

// GET /api/settings — публичный (viewer видит какие вкладки скрыты)
app.get('/api/settings', (req, res) => {
  if (!checkView(req, res)) return;
  res.json(readSettings());
});

// POST /api/settings — только admin
app.post('/api/settings', express.json(), (req, res) => {
  if (!checkAdmin(req, res)) return;
  try {
    const current = readSettings();
    const updated = { ...current, ...req.body };
    // Валидация: hidden_tabs — массив строк
    if (updated.hidden_tabs && !Array.isArray(updated.hidden_tabs))
      return res.status(400).json({ error: 'hidden_tabs должен быть массивом' });
    writeSettings(updated);
    res.json({ ok: true, settings: updated });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ── Helpers ───────────────────────────────────────────────────────────────────
function fmtDate(d) { const [y,m,day]=d.split('-'); return `${day}.${m}.${y}`; }

app.listen(PORT, async () => {
  console.log(`Dashboard on :${PORT} | GitHub: ${GH_OWNER?'✓':'✗'}`);
  await initFromGitHub();
  rebuildWriteoffsIndex();
});

// ── Глобальный обработчик ошибок Express ──────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('Express error:', err.message);
  if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'Файл слишком большой (макс. 25MB)' });
  res.status(500).json({ error: err.message || 'Внутренняя ошибка сервера' });
});

process.on('uncaughtException', err => { console.error('uncaughtException:', err.message); });
process.on('unhandledRejection', err => { console.error('unhandledRejection:', err?.message || err); });

