// timeline.js — original baseline (no history merge)

const ASSIGN_URL = "assignments.json";

const PX_PER_MIN = 8;
const BELTS = [1,2,3,4,5,6,7];
const BELT_ROW_H = 44;
const LANE_TOP_PAD = 32;

async function fetchJSON(url){
  const res = await fetch(url, {cache:"no-store"});
  if(!res.ok) throw new Error(url+" "+res.status);
  return res.json();
}

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

function renderGrid(laneInner, startMs, endMs){
  laneInner.style.height = (LANE_TOP_PAD + BELTS.length * BELT_ROW_H) + "px";

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

async function init(){
  const metaEl = document.getElementById("metaText");
  const laneInner = document.getElementById("laneInner");
  renderBeltColumn();

  let data = {rows:[]};
  try {
    data = await fetchJSON(ASSIGN_URL);
  } catch(err){
    console.error("fetch error:",err);
  }

  const rows = Array.isArray(data.rows) ? data.rows : [];
  if(rows.length === 0) {
    metaEl.textContent = "No rows";
    return;
  }

  let minMs = Infinity, maxMs = -Infinity;
  rows.forEach(r=>{
    const s = Date.parse(r.start);
    const e = Date.parse(r.end);
    if(s<minMs) minMs=s;
    if(e>maxMs) maxMs=e;
  });
  const pad = 30*60000;
  const startMs = minMs - pad;
  const endMs   = maxMs + pad;

  laneInner.innerHTML = "";
  renderGrid(laneInner, startMs, endMs);
  renderPucks(laneInner, rows, startMs);

  if(data.generated_at_local){
    metaEl.textContent = `Updated ${data.generated_at_local} • Horizon ${data.horizon_minutes||""} min`;
  } else {
    metaEl.textContent = `Updated just now`;
  }

  console.log(`Rendered ${rows.length} rows`);
}

document.addEventListener("DOMContentLoaded", init);
