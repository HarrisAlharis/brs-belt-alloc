// timeline.js — fixed to include past 4h history safely

const ASSIGN_URL = "assignments.json";
const HIST_URL   = "alloc-log.json";

// --- config
const PX_PER_MIN         = 8;
const LOOKBACK_MIN       = 4 * 60;   // 4h back
const LOOKAHEAD_MIN      = 3 * 60;   // 3h forward
const PAST_FADE_GRACE_MS = 2 * 60 * 1000;
const BELTS = [1,2,3,4,5,6,7];
const BELT_ROW_H = 44;
const LANE_TOP_PAD = 32;

// --- helpers
function minsDiff(aMs, bMs) { return (aMs - bMs) / 60000; }
function clamp(v,min,max){ return v<min?min:(v>max?max:v); }

async function fetchJSON(url){
  const res = await fetch(url, {cache:"no-store"});
  if(!res.ok) throw new Error(url+" "+res.status);
  return res.json();
}

// --- merge history + live, keep last 4h + future
function buildUnifiedRows(historyArr, assignObj){
  const nowMs = Date.now();
  const cutoffPast = nowMs - LOOKBACK_MIN*60*1000;
  const cutoffFuture = nowMs + LOOKAHEAD_MIN*60*1000;

  const histRows = Array.isArray(historyArr)
    ? historyArr.filter(r => {
        const endMs = r.end ? Date.parse(r.end) : 0;
        return endMs >= cutoffPast && endMs <= cutoffFuture;
      })
    : [];

  const liveRows = Array.isArray(assignObj?.rows)
    ? assignObj.rows
    : [];

  // merge, preferring latest duplicates
  const index = new Map();
  const keyFor = r => {
    const flight = (r.flight||"").trim();
    const startMinute = r.start ? new Date(r.start).toISOString().slice(0,16) : "";
    return flight+"|"+startMinute;
  };

  for (const r of [...histRows, ...liveRows]) {
    if (!r.start || !r.end) continue;
    index.set(keyFor(r), r);
  }

  let merged = [...index.values()];

  // mark past
  merged = merged.map(r=>{
    const endMs = Date.parse(r.end);
    const isPast = (nowMs > (endMs + PAST_FADE_GRACE_MS));
    return {...r, isPast};
  });

  merged.sort((a,b)=> Date.parse(a.start) - Date.parse(b.start));
  return merged;
}

// --- timeline window
function findTimeWindow(rows){
  const now = Date.now();
  const minMs = now - LOOKBACK_MIN*60*1000;
  const maxMs = now + LOOKAHEAD_MIN*60*1000;
  return [minMs, maxMs];
}

// --- render belt labels
function renderBeltColumn(){
  const beltCol = document.getElementById("beltCol");
  beltCol.innerHTML = "";
  BELTS.forEach(b=>{
    const div = document.createElement("div");
    div.className="belt-label";
    div.textContent = "Belt " + b;
    beltCol.appendChild(div);
  });
}

// --- render grid lines + labels
function renderGrid(laneInner, startMs, endMs){
  laneInner.style.height =
    (LANE_TOP_PAD + BELTS.length * BELT_ROW_H) + "px";

  BELTS.forEach((belt, idx)=>{
    const y = LANE_TOP_PAD + idx*BELT_ROW_H;
    const rowLine = document.createElement("div");
    rowLine.className = "belt-row-line";
    rowLine.style.top = y+"px";
    laneInner.appendChild(rowLine);
  });

  const totalMin = Math.ceil((endMs - startMs)/60000);
  for(let m=0;m<=totalMin;m++){
    const thisMs = startMs + m*60000;
    const d = new Date(thisMs);
    const mm = d.getMinutes();
    const hh = d.getHours().toString().padStart(2,"0");
    const minsStr = mm.toString().padStart(2,"0");
    const x = m*PX_PER_MIN;

    if(mm===0){
      const gl = document.createElement("div");
      gl.className="grid-line-hour";
      gl.style.left = x+"px";
      gl.textContent = `${hh}:${minsStr}`;
      laneInner.appendChild(gl);
    } else if(mm%10===0){
      const gl10 = document.createElement("div");
      gl10.className="grid-line-10";
      gl10.style.left = x+"px";
      gl10.textContent = `${hh}:${minsStr}`;
      laneInner.appendChild(gl10);
    }
  }
  laneInner.style.width = (totalMin*PX_PER_MIN + 200) + "px";
}

// --- render pucks
function renderPucks(laneInner, rows, startMs){
  rows.forEach(r=>{
    if(!r.belt || r.belt === "") return;
    const beltIndex = BELTS.indexOf(r.belt);
    if(beltIndex===-1) return;

    const sMs = Date.parse(r.start);
    const eMs = Date.parse(r.end);
    const durMin = (eMs - sMs)/60000;
    if(durMin <= 0) return;
    const offsetMin = (sMs - startMs)/60000;

    const puck = document.createElement("div");
    puck.className = "puck";
    if(r.isPast) puck.classList.add("past");

    const topPx  = LANE_TOP_PAD + beltIndex*BELT_ROW_H + 8;
    const leftPx = offsetMin * PX_PER_MIN;
    const widthPx= durMin * PX_PER_MIN;
    puck.style.top   = topPx+"px";
    puck.style.left  = leftPx+"px";
    puck.style.width = widthPx+"px";

    const flightTxt = (r.flight||"").trim() || "UNK";
    const origTxt   = (r.origin_iata||"").trim();
    const sched     = (r.scheduled_local||"").trim();
    const eta       = (r.eta_local||"").trim();

    const line1 = document.createElement("div");
    line1.className="line1";
    line1.textContent = `${flightTxt} ${origTxt}`;
    const line2 = document.createElement("div");
    line2.className="line2";
    if(sched && eta) line2.textContent = `${sched} → ${eta}`;
    else if(eta) line2.textContent = eta;

    puck.appendChild(line1);
    puck.appendChild(line2);
    laneInner.appendChild(puck);
  });
}

// --- init
async function init(){
  const metaEl = document.getElementById("metaText");
  const laneInner = document.getElementById("laneInner");
  renderBeltColumn();

  let histData = [];
  let liveData = {rows:[]};
  try {
    const [h, a] = await Promise.all([
      fetchJSON(HIST_URL),
      fetchJSON(ASSIGN_URL)
    ]);
    histData = Array.isArray(h)?h:[];
    liveData = a || {rows:[]};
  } catch(err){
    console.error("fetch error:",err);
  }

  const mergedRows = buildUnifiedRows(histData, liveData);
  const [startMs, endMs] = findTimeWindow(mergedRows);

  laneInner.innerHTML = "";
  renderGrid(laneInner, startMs, endMs);
  renderPucks(laneInner, mergedRows, startMs);

  if(liveData.generated_at_local){
    metaEl.textContent = `Updated ${liveData.generated_at_local} • Horizon ${liveData.horizon_minutes||""} min`;
  } else {
    metaEl.textContent = `Updated just now`;
  }

  console.log(`Rendered ${mergedRows.length} rows`);
}

document.addEventListener("DOMContentLoaded", init);
