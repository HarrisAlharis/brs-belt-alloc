/* Timeline renderer — scroll-aware ruler, NOW line, sticky belts, and de-duped pucks */

(() => {
  // ---------- DOM ----------
  const metaEl = document.getElementById('meta');
  const beltsCol = document.getElementById('beltsCol');
  const rowsEl = document.getElementById('rows');
  const ruler = document.getElementById('ruler');
  const scrollOuter = document.getElementById('scrollOuter');
  const scrollInner = document.getElementById('scrollInner');
  const nowLine = document.getElementById('nowLine');
  const zoomSel = document.getElementById('zoom');
  const nowBtn = document.getElementById('nowBtn');
  const beltChips = document.getElementById('beltChips');

  // ---------- CONFIG ----------
  const BELTS = [1,2,3,5,6,7];
  const HISTORY_KEEP_MIN = 240; // 4 hours in browser
  const REFRESH_MS = 90_000;    // ~90s pull
  const RULER_STEP_MIN = 60;    // major tick spacing
  const RULER_SUB_MIN  = 15;    // minor tick spacing

  // State
  let pxPerMin = +zoomSel.value;
  let windowStart = alignHour(new Date());       // start at the nearest hour
  windowStart.setMinutes(windowStart.getMinutes()-60); // show 1h back initially
  windowStart.setSeconds(0,0);
  let windowHours = 8;                            // total virtual width hours
  let beltFilter = new Set(BELTS);                // start showing all

  // ---------- INIT ----------
  renderChips();
  renderBeltsColumn();
  sizeCanvas();
  drawRuler(); // initial
  boot();

  // ---------- Wiring ----------
  zoomSel.addEventListener('change', () => {
    pxPerMin = +zoomSel.value;
    redrawAll();
  });

  nowBtn.addEventListener('click', () => {
    // recenter to keep "now" roughly 35% from left
    const nowX = xForTime(new Date());
    const target = Math.max(0, nowX - scrollOuter.clientWidth*0.35);
    scrollOuter.scrollTo({left: target, behavior:'smooth'});
  });

  scrollOuter.addEventListener('scroll', () => {
    drawRuler();   // make scale match scroll
    placeNowLine();
  });

  window.addEventListener('resize', () => {
    sizeCanvas();
    drawRuler();
    placeNowLine();
  });

  // ---------- Main loop ----------
  async function boot(){
    await loadAndRender();           // first paint
    setInterval(loadAndRender, REFRESH_MS);
    setInterval(() => { placeNowLine(); }, 15_000); // keep now line fresh
  }

  async function loadAndRender(){
    const data = await fetchJSON('assignments.json');
    const gen = data?.generated_at_local || data?.generated_at_utc || '';
    metaEl.textContent = `Generated ${gen} • Horizon ${data?.horizon_minutes || ''} min`;

    const rows = Array.isArray(data?.rows) ? data.rows : [];
    // stamp "seen" time as now for history
    const seenAt = Date.now();

    // 1) Read browser history
    const hist = readHistory();

    // 2) Merge: map by key flight|eta-minute -> newest row
    const mergedMap = new Map();
    function put(r){
      if(!r.eta) return;
      const k = `${(r.flight||'').trim()}|${isoMinute(r.eta)}`;
      const v = {...r, _seenAt: seenAt};
      mergedMap.set(k, v);
    }
    for(const k in hist){
      const r = hist[k];
      put(r);
    }
    for(const r of rows){
      put(r);
    }

    // 3) Filter to last HISTORY_KEEP_MIN (by ETA) and de-dupe
    const now = Date.now();
    const kept = [];
    for(const r of mergedMap.values()){
      const etaMs = +new Date(r.eta);
      const ageMin = Math.round((now - etaMs)/60000);
      if (ageMin <= HISTORY_KEEP_MIN && ageMin > - (windowHours*60)) {
        kept.push(r);
      }
    }
    kept.sort((a,b)=> new Date(a.eta) - new Date(b.eta));

    // 4) Persist back the kept items
    const toStore = {};
    for(const r of kept){
      const k = `${(r.flight||'').trim()}|${isoMinute(r.eta)}`;
      toStore[k] = r;
    }
    writeHistory(toStore);

    // 5) Render rows/pucks
    renderGrid(kept);

    // 6) Sync ruler & now line
    sizeCanvas();
    drawRuler();
    placeNowLine();
  }

  // ---------- Rendering ----------
  function renderChips(){
    // belt chips & toggles
    const frag = document.createDocumentFragment();
    const mk = (label, val) => {
      const c = document.createElement('div');
      c.className = 'chip active';
      c.textContent = `Belt ${label}`;
      c.dataset.val = val;
      c.addEventListener('click', () => {
        if (beltFilter.has(val) && beltFilter.size>1) beltFilter.delete(val);
        else beltFilter.add(val);
        c.classList.toggle('active', beltFilter.has(val));
        updateRowVisibility();
      });
      return c;
    }
    BELTS.forEach(b => frag.appendChild(mk(b,b)));
    // All / None
    const all = document.createElement('div');
    all.className = 'chip';
    all.textContent = 'All';
    all.addEventListener('click', () => {
      beltFilter = new Set(BELTS);
      for(const el of beltChips.children){ el.classList.add('active'); }
      updateRowVisibility();
    });
    const none = document.createElement('div');
    none.className = 'chip';
    none.textContent = 'None';
    none.addEventListener('click', () => {
      beltFilter.clear();
      for(const el of beltChips.children){ el.classList.remove('active'); }
      updateRowVisibility();
    });

    frag.appendChild(all); frag.appendChild(none);
    beltChips.innerHTML = '';
    beltChips.appendChild(frag);
  }

  function renderBeltsColumn(){
    beltsCol.innerHTML = '';
    const topPad = document.createElement('div');
    topPad.style.height = `var(--ruler-h)`;
    beltsCol.appendChild(topPad);
    for(const b of BELTS){
      const d = document.createElement('div');
      d.className = 'belt-label';
      d.textContent = `Belt ${b}`;
      d.dataset.belt = b;
      beltsCol.appendChild(d);
    }
  }

  function renderGrid(items){
    // rows container
    rowsEl.innerHTML = '';
    // compute scroll width based on hours
    const totalMin = windowHours * 60;
    const width = totalMin * pxPerMin + 2000; // a bit extra room
    scrollInner.style.width = `${width}px`;

    // build rows
    const rowMap = new Map(); // belt -> rowEl
    for(const b of BELTS){
      const row = document.createElement('div');
      row.className = 'row';
      row.dataset.belt = b;
      rowsEl.appendChild(row);
      rowMap.set(b, row);
    }

    // place pucks (de-dup already handled in load)
    for(const r of items){
      const belt = r.belt ?? '';
      if (!rowMap.has(belt)) continue;

      const row = rowMap.get(belt);
      const start = new Date(r.start || r.eta);
      const end   = new Date(r.end   || +new Date(r.eta)+45*60000);

      const x = xForTime(start);
      const w = Math.max(120, Math.round((end - start)/60000) * pxPerMin);

      const p = document.createElement('div');
      p.className = 'puck ' + severityClass(r);
      p.style.left = `${x}px`;
      p.style.width = `${w}px`;

      const t1 = document.createElement('div');
      t1.className = 't1';
      t1.textContent = `${(r.flight||'').trim()} • ${(r.origin_iata||r.origin||'').replace(/[()]/g,'').trim()}`;

      const t2 = document.createElement('div');
      t2.className = 't2';
      t2.textContent = `${hhmmLocal(r.start||r.eta)} → ${hhmmLocal(r.end||(+new Date(r.eta)+45*60000))}`;

      p.title = [
        t1.textContent,
        `Time: ${t2.textContent}`,
        `Flow: ${(r.flow||'').toUpperCase()}`,
        `Belt: ${r.belt ?? '?'}`,
        `Reason: ${r.reason||''}`
      ].join('\n');

      p.appendChild(t1); p.appendChild(t2);
      row.appendChild(p);
    }

    updateRowVisibility();
  }

  function updateRowVisibility(){
    for(const row of rowsEl.children){
      const b = +row.dataset.belt;
      row.style.display = beltFilter.has(b) ? '' : 'none';
    }
    for(const lab of beltsCol.querySelectorAll('.belt-label')){
      const b = +lab.dataset.belt;
      lab.style.visibility = beltFilter.has(b) ? 'visible' : 'hidden';
    }
  }

  // ---------- Ruler / NOW ----------
  function sizeCanvas(){
    ruler.width = scrollOuter.clientWidth;
  }

  function drawRuler(){
    const ctx = ruler.getContext('2d');
    const w = ruler.width, h = ruler.height;
    ctx.clearRect(0,0,w,h);
    ctx.font = '12px system-ui'; ctx.textBaseline = 'top';

    const leftMin = scrollOuter.scrollLeft / pxPerMin; // minutes from windowStart
    const startTime = new Date(windowStart.getTime() + leftMin*60000);

    // choose first major tick on/after the view-left rounded to hour
    const firstMajor = new Date(startTime);
    firstMajor.setMinutes(0,0,0);
    while(firstMajor < startTime) firstMajor.setMinutes(firstMajor.getMinutes()+RULER_STEP_MIN);

    // draw ticks across visible width
    const maxMinSpan = Math.ceil(w / pxPerMin) + RULER_STEP_MIN;
    const viewStartMinAbs = minutesSince(windowStart, firstMajor);

    // minor ticks each RULER_SUB_MIN
    ctx.fillStyle = 'rgba(255,255,255,.6)';
    ctx.strokeStyle = 'rgba(255,255,255,.15)';

    // draw minor
    for(let m=viewStartMinAbs - 120; m<viewStartMinAbs + maxMinSpan + 120; m += RULER_SUB_MIN){
      const x = Math.round(m*pxPerMin - (scrollOuter.scrollLeft % (RULER_SUB_MIN*pxPerMin)));
      // thin line
      ctx.beginPath(); ctx.moveTo(x+0.5, 24); ctx.lineTo(x+0.5, h); ctx.stroke();
    }

    // major ticks + labels
    for(let m=viewStartMinAbs; m<viewStartMinAbs + maxMinSpan; m += RULER_STEP_MIN){
      const tickTime = new Date(windowStart.getTime() + m*60000);
      const x = Math.round(m*pxPerMin - (scrollOuter.scrollLeft % (RULER_SUB_MIN*pxPerMin)));
      ctx.fillStyle = 'rgba(255,255,255,.9)';
      const label = hhmm(tickTime);
      // label bg
      const tw = ctx.measureText(label).width + 10;
      ctx.fillStyle = 'rgba(0,0,0,.35)';
      ctx.fillRect(x-4, 4, tw, 16);
      ctx.fillStyle = '#cfe0ff';
      ctx.fillText(label, x, 6);
      // bold grid
      ctx.strokeStyle = 'rgba(255,255,255,.22)';
      ctx.beginPath(); ctx.moveTo(x+0.5, 20); ctx.lineTo(x+0.5, h); ctx.stroke();
    }
  }

  function placeNowLine(){
    const x = xForTime(new Date());
    nowLine.style.left = `${x}px`;
  }

  // ---------- Utils ----------
  function severityClass(r){
    const dm = typeof r.delay_min === 'number' ? r.delay_min : null;
    if (dm == null) return 'ok';
    if (dm >= 20) return 'd20';
    if (dm >= 10) return 'd10';
    if (dm <= -1) return 'early';
    return 'ok';
  }
  function xForTime(t){
    const ms = +t - +windowStart;
    const min = ms/60000;
    return Math.round(min * pxPerMin);
  }
  function alignHour(d){
    const x = new Date(d);
    x.setMinutes(0,0,0);
    return x;
  }
  function minutesSince(a,b){ return Math.round((+b - +a)/60000); }
  function hhmm(d){
    const h = String(d.getHours()).padStart(2,'0');
    const m = String(d.getMinutes()).padStart(2,'0');
    return `${h}:${m}`;
  }
  function hhmmLocal(isoOrDate){
    const d = (isoOrDate instanceof Date) ? isoOrDate : new Date(isoOrDate);
    return hhmm(d);
  }
  function isoMinute(iso){ const d=new Date(iso); d.setSeconds(0,0); return d.toISOString().slice(0,16); }

  async function fetchJSON(path){
    const res = await fetch(`${path}?v=${Date.now()}`, {cache:'no-store'});
    return res.ok ? res.json() : {};
  }
  function readHistory(){
    try{
      const raw = localStorage.getItem('brs_timeline_hist');
      return raw ? JSON.parse(raw) : {};
    }catch{ return {}; }
  }
  function writeHistory(obj){
    try{ localStorage.setItem('brs_timeline_hist', JSON.stringify(obj)); }catch{}
  }
})();
