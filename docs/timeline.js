/*  BRS Timeline (hour-anchored ruler + robust dedupe + frozen belt labels)
    v2025-10-20
*/

(function(){
  // -------- config --------
  const JSON_URL = 'assignments.json';
  const BELTS = [1,2,3,5,6,7];          // lanes in order
  const HISTORY_HOURS = 4;              // show last 4h locally
  const POLL_MS = 90_000;               // auto refresh
  const RULER_STEP_MIN = 60;            // major tick every hour
  const STORAGE_KEY = 'brs_timeline_history_v3'; // bump to reset old caches

  // DOM
  const metaEl = document.getElementById('meta');
  const labelsEl = document.getElementById('laneLabels');
  const lanesEl = document.getElementById('lanes');
  const rulerEl = document.getElementById('timeRuler');
  const nowLine = document.getElementById('nowLine');
  const scrollArea = document.getElementById('scrollArea');
  const zoomSel = document.getElementById('zoomSel');
  const beltFilterGroup = document.getElementById('beltFilter');
  const nowBtn = document.getElementById('nowBtn');

  // state
  let pxPerMin = parseFloat(zoomSel.value || '6');
  let activeBelts = new Set(BELTS);         // belt filter
  let history = loadHistory();              // local 4h memory
  let lastPayload = null;

  // -------- utils --------
  const pad = n=>String(n).padStart(2,'0');
  const mins = ms => Math.floor(ms/60000);

  function hhmm(iso){
    const d = new Date(iso);
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function floorToHour(d){
    const x = new Date(d);
    x.setMinutes(0,0,0);
    return x;
  }
  function ceilToNextHour(d){
    const f = floorToHour(d);
    return (f.getTime() < d.getTime()) ? new Date(f.getTime() + 3600000) : f;
  }

  function loadHistory(){
    try{
      const s = localStorage.getItem(STORAGE_KEY) || '[]';
      const arr = JSON.parse(s);
      return Array.isArray(arr)?arr:[];
    }catch{ return []; }
  }
  function saveHistory(arr){
    try{
      localStorage.setItem(STORAGE_KEY, JSON.stringify(arr));
    }catch{}
  }

  // relaxed, robust key: flight|belt|startMin|endMin (minute precision)
  function relaxedKey(r){
    const f = (r.flight||'').trim().toUpperCase();
    const b = String(r.belt ?? '');
    const s = r.start ? mins(new Date(r.start).getTime()) : '';
    const e = r.end   ? mins(new Date(r.end).getTime())   : '';
    return [f,b,s,e].join('|');
  }

  // de-dupe: keep newest generated_at_utc per relaxedKey
  function dedupeKeepNewest(list){
    const map = new Map();
    for(const r of list){
      const k = relaxedKey(r);
      const existing = map.get(k);
      if(!existing){
        map.set(k, r);
      }else{
        const ga = new Date(existing.generated_at_utc||0).getTime();
        const gb = new Date(r.generated_at_utc||0).getTime();
        if(gb > ga) map.set(k, r);
      }
    }
    return [...map.values()];
  }

  function delayClass(r){
    const dm = (typeof r.delay_min === 'number') ? r.delay_min : null;
    if(dm==null) return 'puck--green';
    if(dm >= 20) return 'puck--red';
    if(dm >= 10) return 'puck--amber';
    if(dm <= -1) return 'puck--blue';
    return 'puck--green';
  }

  // -------- layout/time --------
  function buildTimeWindow(){
    // Window spans from (now - HISTORY_HOURS) to (now + 6h), horizontally scrollable
    const now = new Date();
    const start = new Date(now.getTime() - HISTORY_HOURS*60*60000);
    const end   = new Date(now.getTime() + 6*60*60000);
    return {start, end, now};
  }

  function minsBetween(a,b){ return (b.getTime() - a.getTime())/60000; }

  function setCanvasWidth(win){
    const totalMin = Math.ceil(minsBetween(win.start, win.end));
    const widthPx = Math.max(2000, totalMin * pxPerMin);
    lanesEl.style.width = `${widthPx}px`;
  }

  // hour-anchored ruler
  function drawRuler(win){
    rulerEl.innerHTML = '';
    const firstTick = ceilToNextHour(win.start);
    for(let t = firstTick.getTime(); t <= win.end.getTime(); t += RULER_STEP_MIN*60000){
      const d = new Date(t);
      const x = minsBetween(win.start, d) * pxPerMin;

      const tick = document.createElement('div');
      tick.className = 'tick';
      tick.style.left = `${x}px`;

      const lbl = document.createElement('div');
      lbl.className = 'tlabel';
      lbl.textContent = `${pad(d.getHours())}:00`;
      tick.appendChild(lbl);

      rulerEl.appendChild(tick);
    }
  }

  function drawLabels(){
    labelsEl.innerHTML = '';
    for(const b of BELTS){
      const row = document.createElement('div');
      row.className = 'label-row';
      row.textContent = `Belt ${b}`;
      labelsEl.appendChild(row);
    }
  }

  function placeNowLine(win){
    const x = minsBetween(win.start, win.now) * pxPerMin;
    nowLine.style.left = `${x}px`;
  }

  // -------- data & render --------
  function mergeIntoHistory(currentRows, generated_at_utc){
    const add = currentRows.map(r => ({...r, generated_at_utc}));
    // combine then keep newest per relaxedKey
    const merged = dedupeKeepNewest([...history, ...add]);

    // keep only last HISTORY_HOURS window around “now”
    const cutoffMs = Date.now() - HISTORY_HOURS*60*60000;
    const trimmed = merged.filter(r => {
      const s = r.start ? new Date(r.start).getTime() : 0;
      const e = r.end ? new Date(r.end).getTime() : 0;
      return (s>=cutoffMs || e>=cutoffMs); // anything touching last 4h
    });

    history = dedupeKeepNewest(trimmed);
    saveHistory(history);
  }

  function filteredRows(win){
    // include items whose [start,end] overlaps timeline window and pass belt filter
    const startMs = win.start.getTime();
    const endMs = win.end.getTime();
    const rows = dedupeKeepNewest(history).filter(r => {
      if(!activeBelts.has(Number(r.belt))) return false;
      const s = r.start ? new Date(r.start).getTime() : 0;
      const e = r.end ? new Date(r.end).getTime() : 0;
      return (s <= endMs && e >= startMs);
    });

    // stable sort by start then belt
    rows.sort((a,b)=>{
      const sa = a.start ? new Date(a.start).getTime() : 0;
      const sb = b.start ? new Date(b.start).getTime() : 0;
      if(sa!==sb) return sa-sb;
      return (Number(a.belt)||0) - (Number(b.belt)||0);
    });
    return rows;
  }

  function puckTooltip(r){
    const lines = [
      `${(r.flight||'—').toUpperCase()} • ${(r.origin_iata||'').toUpperCase()}`,
      `${hhmm(r.start)} → ${hhmm(r.end)}`,
      `Status: ${r.status || '—'}`,
      `Flow: ${r.flow || '—'}`,
      `Belt: ${r.belt || '—'}`,
      `Reason: ${r.reason || '—'}`
    ];
    return lines.join('\n');
  }

  function render(win){
    setCanvasWidth(win);
    drawRuler(win);
    placeNowLine(win);

    lanesEl.innerHTML = ''; // clear to prevent visual duplicates

    const laneH = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--lane-h'));
    const puckH = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--puck-h'));
    const vPad = (laneH - puckH)/2;

    const rows = filteredRows(win);
    for(const r of rows){
      const sMin = minsBetween(win.start, new Date(r.start));
      const eMin = minsBetween(win.start, new Date(r.end));
      const left = sMin * pxPerMin;
      const width = Math.max(24, (eMin - sMin) * pxPerMin);

      const laneIndex = BELTS.indexOf(Number(r.belt));
      if(laneIndex < 0) continue;
      const top = laneIndex * laneH + vPad;

      const puck = document.createElement('div');
      puck.className = `puck ${delayClass(r)}`;
      puck.style.left = `${left}px`;
      puck.style.top = `${top}px`;
      puck.style.width = `${width}px`;
      puck.setAttribute('data-tip', puckTooltip(r));

      const title = document.createElement('div');
      title.className = 'title';
      title.textContent = `${(r.flight||'').toUpperCase()} • ${(r.origin_iata||'').toUpperCase()}`;
      const time = document.createElement('div');
      time.className = 'time';
      time.textContent = `${hhmm(r.start)} → ${hhmm(r.end)}`;

      puck.appendChild(title);
      puck.appendChild(time);
      lanesEl.appendChild(puck);
    }

    // update meta
    metaEl.textContent = `Generated ${lastPayload?.generated_at_local || '—'} • Horizon ${lastPayload?.horizon_minutes || ''} min`;
  }

  // -------- actions --------
  async function loadOnce(){
    const res = await fetch(`${JSON_URL}?v=${Date.now()}`);
    const data = await res.json();
    lastPayload = data;

    const rows = Array.isArray(data.rows) ? data.rows : [];
    mergeIntoHistory(rows, data.generated_at_utc || new Date().toISOString());

    render(buildTimeWindow());
  }

  function tick(){
    placeNowLine(buildTimeWindow());
  }

  // -------- UI wiring --------
  function init(){
    drawLabels();

    beltFilterGroup.addEventListener('click', (e)=>{
      const b = e.target?.dataset?.belt;
      if(!b) return;
      if(b==='all'){ activeBelts = new Set(BELTS); }
      else if(b==='none'){ activeBelts = new Set(); }
      else {
        const n = Number(b);
        if(activeBelts.has(n)) activeBelts.delete(n); else activeBelts.add(n);
      }
      render(buildTimeWindow());
    });

    zoomSel.addEventListener('change', ()=>{
      pxPerMin = parseFloat(zoomSel.value||'6');
      render(buildTimeWindow());
    });

    nowBtn.addEventListener('click', ()=>{
      const win = buildTimeWindow();
      const x = minsBetween(win.start, win.now) * pxPerMin;
      const half = scrollArea.clientWidth/2;
      scrollArea.scrollTo({ left: Math.max(0, x - half), behavior:'smooth' });
    });

    loadOnce().catch(console.error);
    setInterval(loadOnce, POLL_MS);
    setInterval(tick, 10_000);
  }

  init();
})();
