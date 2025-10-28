// timeline.js
// minimal renderer using assignments.json + alloc-log.json
// shows past 4h + future on a belt grid
// assumes this file sits in /docs next to those JSON files

const ASSIGN_URL = "assignments.json";
const HIST_URL   = "alloc-log.json";

// --- config
const PX_PER_MIN         = 8;        // 8px per minute
const LOOKBACK_MIN       = 4 * 60;   // 4 hours history
const PAST_FADE_GRACE_MS = 2 * 60 * 1000; // 2 minutes grace after end before grey
const BELTS = [1,2,3,4,5,6,7];       // always render all belts
const BELT_ROW_H = 44;               // must match CSS var(--belt-row-h)
const LANE_TOP_PAD = 32;             // must match CSS var(--lane-top-pad)

// --- helpers
function minsDiff(aMs, bMs) {
  return (aMs - bMs) / 60000;
}
function clamp(v,min,max){ return v<min?min:(v>max?max:v); }

async function fetchJSON(url){
  const res = await fetch(url, {cache:"no-store"});
  if(!res.ok) throw new Error(url+" "+res.status);
  return res.json();
}

// merge history + live, dedupe
function buildUnifiedRows(historyArr, assignObj){
  const nowMs = Date.now();
  const cutoffMs = nowMs - LOOKBACK_MIN*60*1000;

  // historyArr is already an array in your alloc-log.json
  const histRows = Array.isArray(historyArr)
    ? historyArr.filter(r => {
        const endMs = r.end ? Date.parse(r.end) : 0;
        return endMs >= cutoffMs; // only keep last 4h
      })
    : [];

  const liveRows = Array.isArray(assignObj?.rows)
    ? assignObj.rows
    : [];

  // merge, preferring latest duplicate (same flight+start minute)
  const index = new Map();
  function keyFor(r){
    const flight = (r.flight||"").trim();
    const startMinute = r.start ? new Date(r.start).toISOString().slice(0,16) : "";
    return flight+"|"+startMinute;
  }
  for(const r of [...histRows, ...liveRows]){
    if(!r.start || !r.end) continue;
    index.set(keyFor(r), r);
  }

  let merged = [...index.values()];

  // mark past / upcoming
  merged = merged.map(r=>{
    const endMs = Date.parse(r.end);
    const isPast = (Date.now() > (endMs + PAST_FADE_GRACE_MS));
    return {...r, isPast};
  });

  // sort by start time
  merged.sort((a,b)=> Date.parse(a.start) - Date.parse(b.start));
  return merged;
}

// figure timeline window
function findTimeWindow(rows){
  if(rows.length===0){
    const now = Date.now();
    const startMs = now - 60*60000;     // show 1h back
    const endMs   = now + 180*60000;    // +3h ahead
    return [startMs,endMs];
  }
  let minMs = Infinity;
  let maxMs = -Infinity;
  for(const r of rows){
    const s = Date.parse(r.start);
    const e = Date.parse(r.end);
    if(s<minMs) minMs=s;
    if(e>maxMs) maxMs=e;
  }
  // pad 30m each side
  const pad = 30*60000;
  minMs -= pad;
  maxMs += pad;
  return [minMs,maxMs];
}

// render belt labels (left column)
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

// render grid lines and hour ticks
function renderGrid(laneInner, startMs, endMs){
  // height setup
  laneInner.style.height =
    (LANE_TOP_PAD + BELTS.length * BELT_ROW_H) + "px";

  // belt horizontal lines
  BELTS.forEach((belt, idx)=>{
    const y = LANE_TOP_PAD + idx*BELT_ROW_H;
    const rowLine = document.createElement("div");
    rowLine.className = "belt-row-line";
    rowLine.style.top = y+"px";
    laneInner.appendChild(rowLine);
  });

  // vertical minute grid every 10 min + hour label every 60
  const totalMin = Math.ceil((endMs - startMs)/60000);
  for(let m=0;m<=totalMin;m++){
    const thisMs = startMs + m*60000;
    const d = new Date(thisMs);
    const mm = d.getMinutes();
    const hh = d.getHours().toString().padStart(2,"0");
    const minsStr = mm.toString().padStart(2,"0");

    const x = m*PX_PER_MIN;
    if(mm===0){
      // hour line
      const gl = document.createElement("div");
      gl.className="grid-line-hour";
      gl.style.left = x+"px";
      gl.textContent = `${hh}:${minsStr}`;
      laneInner.appendChild(gl);
    } else if(mm%10===0){
      // 10-min line
      const gl10 = document.createElement("div");
      gl10.className="grid-line-10";
      gl10.style.left = x+"px";
      gl10.textContent = `${hh}:${minsStr}`;
      laneInner.appendChild(gl10);
    }
  }

  // width so scroll works
  laneInner.style.width = (totalMin*PX_PER_MIN + 200) + "px";
}

// render each flight puck
function renderPucks(laneInner, rows, startMs){
  rows.forEach(r=>{
    // skip if belt missing or belt == "" (unallocated)
    if(!r.belt || r.belt === "") return;

    const beltIndex = BELTS.indexOf(r.belt);
    if(beltIndex===-1) return; // belt not in our list

    const sMs = Date.parse(r.start);
    const eMs = Date.parse(r.end);
    const durMin = (eMs - sMs)/60000;
    if(durMin <= 0) return;

    const offsetMin = (sMs - startMs)/60000;

    const puck = document.createElement("div");
    puck.className = "puck";
    if(r.isPast) puck.classList.add("past");

    // position
    const topPx  = LANE_TOP_PAD + beltIndex*BELT_ROW_H + 8; // +8px padding
    const leftPx = offsetMin * PX_PER_MIN;
    const widthPx= durMin * PX_PER_MIN;

    puck.style.top    = topPx+"px";
    puck.style.left   = leftPx+"px";
    puck.style.width  = widthPx+"px";

    // label text:
    const flightTxt = (r.flight||"").trim() || "UNK";
    const origTxt   = (r.origin_iata||"").trim();
    const sched     = (r.scheduled_local||"").trim();
    const eta       = (r.eta_local||"").trim();

    const line1 = document.createElement("div");
    line1.className="line1";
    line1.textContent = `${flightTxt} ${origTxt}`;

    const line2 = document.createElement("div");
    line2.className="line2";
    if(sched && eta){
      line2.textContent = `${sched} → ${eta}`;
    } else if(eta){
      line2.textContent = eta;
    } else {
      line2.textContent = "";
    }

    puck.appendChild(line1);
    puck.appendChild(line2);

    laneInner.appendChild(puck);
  });
}

// main init
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

  // merge + decorate
  const mergedRows = buildUnifiedRows(histData, liveData);

  // time window
  const [startMs, endMs] = findTimeWindow(mergedRows);

  // clear laneInner for fresh draw
  laneInner.innerHTML = "";

  // draw grid + lines
  renderGrid(laneInner, startMs, endMs);

  // draw pucks
  renderPucks(laneInner, mergedRows, startMs);

  // header meta
  if(liveData.generated_at_local){
    metaEl.textContent = `Updated ${liveData.generated_at_local} • Horizon ${liveData.horizon_minutes||""} min`;
  } else {
    metaEl.textContent = `Updated just now`;
  }

  console.log(`Rendered ${mergedRows.length} rows`);
}

document.addEventListener("DOMContentLoaded", init);
