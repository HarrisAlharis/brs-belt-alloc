/*  BRS Timeline (frozen belt column + horizontal scroll + de-dup + tooltips)
    - Pucks show only “FLIGHT • ORIGIN” (details on hover)
    - Left belt labels stay frozen (sticky) while you scroll time
    - Dedupe ensures no duplicate pucks even with history + live merges
*/

(function(){
  // -------- config --------
  const JSON_URL = 'assignments.json';
  const BELTS = [1,2,3,5,6,7];          // lanes in order
  const HISTORY_HOURS = 4;              // show last 4h locally
  const POLL_MS = 90_000;               // auto refresh
  const RULER_MAJOR_MIN = 60;
  const RULER_MINOR_MIN = 15;

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
  let lastDraw = null;

  // -------- utils --------
  const pad = n=>String(n).padStart(2,'0');
  const hhmm = iso => {
    const d = new Date(iso); return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };
  const mins = ms => Math.floor(ms/60000);
  const clamp = (v,a,b)=>Math.max(a,Math.min(b,v));

  function loadHistory(){
    try{
      const s = localStorage.getItem('brs_timeline_history_v2') || '[]';
      const arr = JSON.parse(s);
      return Array.isArray(arr)?arr:[];
    }catch{ return []; }
  }
  function saveHistory(arr){
    try{
      localStorage.setItem('brs_timeline_history_v2', JSON.stringify(arr));
    }catch{}
  }

  function keyFor(r){
    return [
      r.flight||'',
      r.origin_iata||'',
      r.belt||'',
      r.start||'',
      r.end||''
    ].join('|');
  }

  // dedupe: keep the newest copy when keys collide
  function dedupe(list){
    const seen = new Map();
    for(const r of list){
      const k = keyFor(r);
      if(!seen.has(k)) { seen.set(k, r); continue; }
      // choose the one with latest generated_at if present, else keep first
      const a = seen.get(k);
      const ga = new Date(a.generated_at_utc||0).getTime();
      const gb = new Date(r.generated_at_utc||0).getTime();
      if(gb > ga) seen.set(k, r);
    }
    return [...seen.values()];
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

    // set the repeating grid backgrounds (major = 60 min, minor = 15 min)
    const majorW = RULER_MAJOR_MIN * pxPerMin;
    const minorW = RULER_MINOR_MIN * pxPerMin;
    lanesEl.style.setProperty('--majorW', `${majorW}px`);
    lanesEl.style.setProperty('--minorW', `${minorW}px`);
    lanesEl.style.backgroundSize = `100% var(--lane-h)`;
    lanesEl.style.setProperty('--laneRepeat','');

    // draw grid verticals via ::before:  we need sizes on that pseudo element
    lanesEl.style.setProperty('--majorX', `${majorW}px`);
    lanesEl.style.setProperty('--minorX', `${minorW}px`);
    lanesEl.style.setProperty('background-position', '0 0');

    // apply to ::before
    lanesEl.style.setProperty('--before-major', `${majorW}px`);
    lanesEl.style.setProperty('--before-minor', `${minorW}px`);
    lanesEl.style.setProperty('--before-height', `100%`);
    lanesEl.style.setProperty('--before-left', `0`);
    lanesEl.style.setProperty('--before-top', `0`);

    // using style here to position grid in CSS:
    lanesEl.style.setProperty('--majorW', `${majorW}px`);
    lanesEl.style.setProperty('--minorW', `${minorW}px`);
    lanesEl.style.setProperty('--gridMajor', `repeating-linear-gradient(90deg, var(--grid) 0 1px, transparent 1px ${majorW}px)`);
    lanesEl.style.setProperty('--gridMinor', `repeating-linear-gradient(90deg, var(--grid-soft) 0 1px, transparent 1px ${minorW}px)`);
    lanesEl.style.setProperty('--gridBoth', `linear-gradient(90deg, var(--grid) 1px, transparent 1px), linear-gradient(90deg, var(--grid-soft) 1px, transparent 1px)`);
    lanesEl.style.setProperty('--gridMajorSize', `${majorW}px 100%`);
    lanesEl.style.setProperty('--gridMinorSize', `${minorW}px 100%`);

    // emulate ::before via CSS rule (configured earlier in CSS):
    lanesEl.style.setProperty('--dummy','');
    lanesEl.style.setProperty('--gridMajorSize','');
  }

  function drawRuler(win){
    rulerEl.innerHTML = '';
    const totalMin = Math.ceil(minsBetween(win.start, win.end));
    const step = 60; // major hour ticks
    for(let m=0;m<=totalMin;m+=step){
      const x = m * pxPerMin;
      const tick = document.createElement('div');
      tick.className = 'tick';
      tick.style.left = `${x}px`;
      const d = new Date(win.start.getTime() + m*60000);
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

  function beltToY(beltIndexZero){
    return beltIndexZero * parseInt(getComputedStyle(document.documentElement).getPropertyValue('--lane-h'));
  }

  function placeNowLine(win){
    const m = minsBetween(win.start, win.now);
    nowLine.style.left = `${m*pxPerMin}px`;
  }

  // -------- data & render --------
  function mergeIntoHistory(currentRows, generated_at_utc){
    const add = currentRows.map(r => ({...r, generated_at_utc}));
    const merged = dedupe([...history, ...add]);
    // keep only last HISTORY_HOURS window around “now”
    const cutoffMs = Date.now() - HISTORY_HOURS*60*60000;
    const trimmed = merged.filter(r => {
      const s = r.start ? new Date(r.start).getTime() : 0;
      const e = r.end ? new Date(r.end).getTime() : 0;
      return (s>=cutoffMs || e>=cutoffMs); // anything touching last 4h
    });
    history = trimmed;
    saveHistory(history);
  }

  function filteredRows(win){
    // include items whose [start,end] overlaps timeline window
    const startMs = win.start.getTime();
    const endMs = win.end.getTime();
    return dedupe(history).filter(r => {
      if(!activeBelts.has(Number(r.belt))) return false;
      const s = r.start ? new Date(r.start).getTime() : 0;
      const e = r.end ? new Date(r.end).getTime() : 0;
      return (s <= endMs && e >= startMs);
    });
  }

  function puckTooltip(r){
    const lines = [
      `${r.flight || '—'} • ${ (r.origin_iata||'').toUpperCase() }`,
      `${hhmm(r.start)} → ${hhmm(r.end)}`,
      `Status: ${r.status || '—'}`,
      `Flow: ${r.flow || '—'}`,
      `Belt: ${r.belt || '—'}`,
      `Reason: ${r.reason || '—'}`
    ];
    return lines.join('\n');
  }

  function render(win){
    // avoid unnecessary reflow if same width/zoom
    setCanvasWidth(win);
    drawRuler(win);
    placeNowLine(win);

    lanesEl.innerHTML = ''; // clear (prevents visual duplicates)
    const laneH = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--lane-h'));

    const rows = filteredRows(win);
    for(const r of rows){
      // compute x/width
      const sMin = minsBetween(win.start, new Date(r.start));
      const eMin = minsBetween(win.start, new Date(r.end));
      const left = sMin * pxPerMin;
      const width = Math.max(24, (eMin - sMin) * pxPerMin);

      const laneIndex = BELTS.indexOf(Number(r.belt));
      if(laneIndex < 0) continue;
      const top = laneIndex * laneH + (laneH - parseInt(getComputedStyle(document.documentElement).getPropertyValue('--puck-h')))/2;

      const puck = document.createElement('div');
      puck.className = `puck ${delayClass(r)}`;
      puck.style.left = `${left}px`;
      puck.style.top = `${top}px`;
      puck.style.width = `${width}px`;
      puck.setAttribute('data-tip', puckTooltip(r));

      const title = document.createElement('div');
      title.className = 'title';
      const origin = (r.origin_iata||'').toUpperCase();
      title.textContent = `${(r.flight||'').toUpperCase()} • ${origin}`;
      const time = document.createElement('div');
      time.className = 'time';
      time.textContent = `${hhmm(r.start)} → ${hhmm(r.end)}`;

      puck.appendChild(title);
      puck.appendChild(time);
      lanesEl.appendChild(puck);
    }

    // update meta
    const gen = lastDraw?.generated_at_local || '—';
    metaEl.textContent = `Generated ${gen} • Horizon ${lastDraw?.horizon_minutes || ''} min`;
  }

  // -------- actions --------
  async function loadOnce(){
    const url = `${JSON_URL}?v=${Date.now()}`;
    const res = await fetch(url);
    const data = await res.json();

    // stash for meta
    lastDraw = data;

    // merge rows into local 4h history
    const rows = Array.isArray(data.rows) ? data.rows : [];
    mergeIntoHistory(rows, data.generated_at_utc || new Date().toISOString());

    const win = buildTimeWindow();
    render(win);
  }

  function tick(){
    const win = buildTimeWindow();
    placeNowLine(win);
  }

  // -------- UI wiring --------
  function init(){
    // labels (frozen)
    drawLabels();

    // belt filter
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

    // zoom
    zoomSel.addEventListener('change', ()=>{
      pxPerMin = parseFloat(zoomSel.value||'6');
      render(buildTimeWindow());
    });

    // “Now” scrolls the scrollArea so the blue line is centered
    nowBtn.addEventListener('click', ()=>{
      const win = buildTimeWindow();
      const x = minsBetween(win.start, win.now) * pxPerMin;
      const half = scrollArea.clientWidth/2;
      scrollArea.scrollTo({ left: Math.max(0, x - half), behavior:'smooth' });
    });

    // refresh loop
    loadOnce().catch(console.error);
    setInterval(loadOnce, POLL_MS);
    setInterval(tick, 15_000); // move the “now” line slightly
  }

  init();
})();
