import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import simpleGit from 'simple-git';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import { chromium } from 'playwright';

dayjs.extend(utc);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --------- CONFIG YOU MUST SET (later on your home PC) ---------
const REPO_USER = "<YOUR_GITHUB_USERNAME>";
const REPO_NAME = "brs-belt-alloc";
const BRANCH    = "main";
// ---------------------------------------------------------------

const GH_TOKEN  = process.env.GH_TOKEN || "";
const ROOT      = path.resolve(__dirname, "..");
const DOCS_DIR  = path.join(ROOT, "docs");
const RULES_FN  = path.join(ROOT, "rules.json");
const OUT_FN    = path.join(DOCS_DIR, "assignments.json");

const FR24_URL  = "https://www.flightradar24.com/data/airports/brs/arrivals";

// --- SELECTORS: Update if FR24 markup changes ---
const SELECTORS = {
  row: "table tbody tr",              // adjust if FR24 changes
  flight: "td:nth-child(2)",
  origin: "td:nth-child(3)",
  eta: "td:nth-child(5)",
  status: "td:nth-child(6)"
};

function parseRowText(txt){
  const flightMatch = txt.match(/\b([A-Z]{2,3}\d{2,4})\b/);
  const iataMatch   = txt.match(/\b([A-Z]{3})\b(?!\))/);
  const timeMatch   = txt.match(/\b([01]\d|2[0-3]):([0-5]\d)\b/);
  const statusMatch = txt.match(/\b(en route|estimated|approaching|landing|arrived|cancelled|scheduled|diverted|not departed)\b/i);
  return {
    flight: flightMatch ? flightMatch[1] : "",
    origin_iata: iataMatch ? iataMatch[1] : "",
    eta_local: timeMatch ? timeMatch[0] : "",
    status: statusMatch ? statusMatch[1] : ""
  };
}

async function scrapeArrivals(){
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36"
  });
  await page.goto(FR24_URL, { waitUntil: "domcontentloaded", timeout: 90000 });
  await page.waitForTimeout(4000);
  let rows = [];
  try {
    await page.waitForSelector(SELECTORS.row, { timeout: 10000 });
    rows = await page.$$eval(SELECTORS.row, (els, sel) => {
      return els.map(el => {
        function txt(q){ const n = el.querySelector(q); return n ? n.textContent.trim() : ""; }
        return {
          flight: txt(sel.flight),
          origin_iata: (txt(sel.origin).match(/\b[A-Z]{3}\b/)||[""])[0],
          eta_local: txt(sel.eta),
          status: txt(sel.status).toLowerCase()
        };
      });
    }, SELECTORS);
  } catch(e) {
    const generic = await page.$$eval("tr, li, div", els => els.map(el => el.textContent.trim()).filter(t=>t && t.length>40));
    rows = generic.map(parseRowText).filter(r=>r.flight && r.eta_local);
  }
  await browser.close();
  return rows;
}

function loadRules(){
  const raw = fs.readFileSync(RULES_FN, "utf-8");
  return JSON.parse(raw);
}

function classifyFlow(origin, rules){
  const o = (origin||"").toUpperCase();
  if (rules.flows.CTA.iata_origins.includes(o)) return "CTA";
  if (rules.flows.DOMESTIC.iata_origins.includes(o)) return "DOMESTIC";
  return "INTERNATIONAL";
}

function overlaps(a, b){ return a.start < b.end && b.start < a.end; }

function assignBelts(rows, rules){
  const now = dayjs.utc();
  const horizon = rules.horizon_minutes;
  const inc = rules.status_include.map(s=>s.toLowerCase());
  const exc = rules.status_exclude.map(s=>s.toLowerCase());

  function etaToUtc(eta_local){
    const today = dayjs();
    const parts = (eta_local||"").split(":");
    if (parts.length<2) return null;
    const local = today.hour(parseInt(parts[0],10)).minute(parseInt(parts[1],10)).second(0).millisecond(0);
    let adjusted = local;
    if (local.isBefore(today.subtract(12,'hour'))) adjusted = local.add(1,'day');
    return adjusted.utc();
  }

  const flights = rows.map(r=>{
    const etaUtc = etaToUtc(r.eta_local);
    return {
      flight: r.flight,
      origin_iata: (r.origin_iata||"").toUpperCase(),
      status: (r.status||"").toLowerCase(),
      eta: etaUtc
    };
  }).filter(f=>f.flight && f.eta);

  const filtered = flights.filter(f=>{
    if (exc.some(x=>f.status.includes(x))) return false;
    if (inc.length && !inc.some(x=>f.status.includes(x))) return false;
    const dt = f.eta.diff(now, 'minute');
    return dt>0 && dt<=horizon;
  }).sort((a,b)=>a.eta.valueOf() - b.eta.valueOf());

  const schedule = new Map();
  for (const b of rules.belts.map(b=>b.id)) schedule.set(b, []);

  const results = [];

  function neighborsInWindow(i){
    for (let j=Math.max(0,i-3); j<Math.min(filtered.length,i+4); j++){
      if (j===i) continue;
      const diff = Math.abs(filtered[j].eta.diff(filtered[i].eta, 'minute'));
      if (diff <= rules.density_minutes) return true;
    }
    return false;
  }

  function windowFor(flow, eta){
    const bf = rules.flows[flow].buffers;
    const start = eta.add(bf.start,'minute');
    const end   = start.add(bf.dwell + bf.cleanup,'minute');
    return {start, end};
  }

  function beltAvailable(belt, win){
    for (const o of rules.outages){
      if (o.belt === belt){
        const os = dayjs.utc(o.start), oe = dayjs.utc(o.end);
        if (overlaps({start:win.start.toDate(), end:win.end.toDate()}, {start:os.toDate(), end:oe.toDate()})) return false;
      }
    }
    return true;
  }

  function beltLoadScore(belt){
    const arr = schedule.get(belt) || [];
    const total = arr.reduce((s,w)=>s + w.end.diff(w.start,'minute'), 0);
    return {count: arr.length, total};
  }

  for (let i=0;i<filtered.length;i++){
    const f = filtered[i];
    const flow = classifyFlow(f.origin_iata, rules);
    const w   = windowFor(flow, f.eta);
    const targets = [...rules.flows[flow].targets];

    let candidates = targets.filter(b=>beltAvailable(b, w));
    candidates.sort((x,y)=>{
      const lx = beltLoadScore(x), ly = beltLoadScore(y);
      return (lx.count - ly.count) || (lx.total - ly.total) || (x - y);
    });

    const many = neighborsInWindow(i);
    if (many && !candidates.includes(5) && rules.belts.find(b=>b.id===5)){
      if (beltAvailable(5, w)) candidates.push(5);
    }

    let placed = false, chosen = null, reason = "";
    for (const b of candidates){
      const arr = schedule.get(b);
      if (arr.length >= rules.max_queue_per_belt) continue;
      const clash = arr.some(win=>overlaps({start:w.start.toDate(), end:w.end.toDate()}, {start:win.start.toDate(), end:win.end.toDate()}));
      if (clash) continue;
      arr.push({start: w.start, end: w.end, flight: f.flight});
      chosen = b;
      reason = many && b===5 ? "density_overflow" : (flow==="CTA" && b===6 ? "cta_pref" : (flow==="DOMESTIC" && b===7 ? "dom_pref" : "spread"));
      placed = true;
      break;
    }
    if (!placed){
      results.push({ flight:f.flight, origin:f.origin_iata, eta:f.eta.toISOString(), status:f.status, flow, belt:"", start:w.start.toISOString(), end:w.end.toISOString(), reason:"UNASSIGNED" });
    } else {
      results.push({ flight:f.flight, origin:f.origin_iata, eta:f.eta.toISOString(), status:f.status, flow, belt:chosen, start:w.start.toISOString(), end:w.end.toISOString(), reason });
    }
  }

  return {
    generated_at: dayjs.utc().toISOString(),
    horizon_minutes: rules.horizon_minutes,
    rows: results
  };
}

async function main(){
  const rules = loadRules();
  const raw = await scrapeArrivals();
  const data = assignBelts(raw, rules);

  if (!fs.existsSync(DOCS_DIR)) fs.mkdirSync(DOCS_DIR, { recursive: true });
  fs.writeFileSync(OUT_FN, JSON.stringify(data, null, 2));

  const git = simpleGit({ baseDir: path.resolve(__dirname, "..") });
  try { await git.add(["docs/assignments.json"]); } catch{}
  const msg = `update assignments ${dayjs().format('YYYY-MM-DD HH:mm:ss')}`;
  try { await git.commit(msg); } catch{}
  await git.push("origin", BRANCH).catch(e=>console.log("git push failed (check token or origin):", e.message));
}

main().catch(err=>{
  console.error("Feeder error:", err);
  process.exit(1);
});
