/* BRS timeline — crisp DPR-aware ruler, correct tick math, sticky belts, de-dup by flight-per-day */

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
  const HISTORY_KEEP_MIN = 240; // 4h
  const REFRESH_MS = 90_000;

  // State
  let pxPerMin = +zoomSel.value;
  let windowStart = floorHour(new Date());
  windowStart.setMinutes(windowStart.getMinutes() - 60); // start 1h back
  windowStart.setSeconds(0,0);
  let windowHours = 8;
  let beltFilter = new Set(BELTS);

  // ---------- INIT ----------
  renderChips();
  renderBeltsColumn();
  resizeRuler(); drawRuler();
  boot();

  // ---------- Events ----------
  zoomSel.addEventListener('change', () => {
    pxPerMin = +zoomSel.value;
    redrawAll();
  });

  nowBtn.addEventListener('click', () => {
    const nowX = xForTime(new Date());
    const target = Math.max(0, nowX - scrollOuter.clientWidth*0.35);
    scrollOuter.scrollTo({left: target, behavior:'smooth'});
  });

  scrollOuter.addEventListener('scroll', () => {
    drawRuler();
    placeNowLine();
  });

  window.addEventListener('resize', () => {
    resizeRuler();
    drawRuler();
    placeNowLine();
  });

  // ---------- Loop ----------
  async function boot(){
    await loadAndRender();
    setInterval(loadAndRender, REFRESH_MS);
    setInterval(placeNowLine, 15_000);
  }

  async function loadAndRender(){
    const data = await getJSON('assignments.json');
    const gen = data?.generated_at_local || data?.generated_at_utc || '';
    metaEl.textContent = `Generated ${gen} • Horizon ${data?.horizon_minutes || ''} min`;

    const rows = Array.isArray(data?.rows) ? data.rows : [];
    const seenAt = Date.now();

    // merge with 4h history and de-dup per FLIGHT|DAY (keep newest)
    const hist = readHist();
    const merged = new Map();

    function primaryKey(r){
      const d = new Date(r.eta || r.start);
      return `${(r.flight||'').trim()}|${isoDay(d)}`;
    }
    function secondaryKey(r){
      // If an airline actually reuses the same flight number twice in one day (rare),
      // add a second discriminator: nearest start "quarter-hour" bucket.
      const d = new Date(r.start || r.eta);
      const q = Math.floor(d.getHours()*60/15 + d.getMinutes()/15);
      return `${(r.flight||'').trim()}|${isoDay(d)}|Q${q}`;
    }

    function put(r, when){
      if(!r) return;
      // prefer primary key; if collision with different real flights (very rare), fallback to secondary
      const k1 = primaryKey(r);
      const prev = merged.get(k1);
      if (!prev || (prev._seenAt||0) < when){
        merged.set(k1, {...r, _seenAt: when, _k: k1});
        return;
      }
      // If the existing and incoming are truly far apart (>2h in ETA), treat as distinct by secondary key.
      const etaNew = +new Date(r.eta || r.start || 0);
      const etaOld = +new Date(prev.eta || prev.start || 0);
      if (Math.abs(etaNew - etaOld) > 120*60000){
        const k2 = secondaryKey(r);
        const prev2 = merged.get(k2);
        if (!prev2 || (prev2._seenAt||0) < when){
          merged.set(k2, {...r, _seenAt: when, _k: k2});
        }
      } else {
        // Same flight same day minor ETA drift → keep the newest
        if ((prev._seenAt||0) < when){
          merged.set(k1, {...r, _seenAt: when, _k: k1});
        }
      }
    }

    // bring forward history
    for (const key of Object.keys(hist)){
      const r = hist[key];
      put(r, r._seenAt || (Date.now() - 91_000)); // ensure older than fresh pull
    }
    // apply latest feed
    for (const r of rows) put(r, seenAt);

    // prune: outside 4h (from ETA)
    const now = Date.now();
    const kept = [];
    for (const r of merged.values()){
      const eta = +new Date(r.eta || r.start || 0);
      const ageMin = Math.round((now - eta)/60000);
      if (ageMin <= HISTORY_KEEP_MIN && ageMin > -(windowHours*60)) kept.push(r);
    }
    kept.sort((a,b)=>+new Date(a.eta || a.start) - +new Date(b.eta || b.start));

    // save reduced history
    const store = {};
    for (const r of kept){
      const key = r._k || primaryKey(r);
      store[key] = r;
    }
    writeHist(store);

    renderGrid(kept);
    resizeRuler(); drawRuler(); placeNowLine();
  }

  // ---------- Rendering ----------
  function renderChips(){
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
    };
    BELTS.forEach(b => frag.appendChild(mk(b,b)));

    const all = document.createElement('div');
    all.className = 'chip'; all.textContent = 'All';
    all.addEventListener('click', () => {
      beltFilter = new Set(BELTS);
      for (const el of beltChips.children) el.classList.add('active');
      updateRowVisibility();
    });

    const none = document.createElement('div');
    none.className = 'chip'; none.textContent = 'None';
    none.addEventListener('click', () => {
      beltFilter.clear();
      for (const el of beltChips.children) el.classList.remove('active');
      updateRowVisibility();
    });

    frag.appendChild(all); frag.appendChild(none);
    beltChips.innerHTML = '';
    beltChips.appendChild(frag);
  }

  function renderBeltsColumn(){
    beltsCol.innerHTML = '';
    const pad = document.createElement('div');
    pad.style.height = 'var(--ruler-h)';
    beltsCol.appendChild(pad);
    for (const b of BELTS){
      const d = document.createElement('div');
      d.className = 'belt-label';
      d.dataset.belt = b;
      d.textContent = `Belt ${b}`;
      beltsCol.appendChild(d);
    }
  }

  function renderGrid(items){
    rowsEl.innerHTML = '';

    const width = windowHours*60*pxPerMin + 2000;
    scrollInner.style.width = `${width}px`;

    const rowMap = new Map();
    for (const b of BELTS){
      const row = document.createElement('div');
      row.className = 'row';
      row.dataset.belt = b;
      rowsEl.appendChild(row);
      rowMap.set(b,row);
    }

    for (const r of items){
      const belt = r.belt ?? '';
      if (!rowMap.has(belt)) continue;

      const start = new Date(r.start || r.eta);
      const end   = new Date(r.end   || (+new Date(r.eta) + 45*60000));

      const x = xForTime(start);
      const w = Math.max(120, Math.round((end - start)/60000) * pxPerMin);

      const p = document.createElement('div');
      p.className = 'puck ' + sevClass(r);
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
        `Belt: ${belt}`,
        `Reason: ${r.reason||''}`
      ].join('\n');

      p.appendChild(t1); p.appendChild(t2);
      rowMap.get(belt).appendChild(p);
    }

    updateRowVisibility();
  }

  function updateRowVisibility(){
    for (const row of rowsEl.children){
      const b = +row.dataset.belt;
      row.style.display = beltFilter.has(b) ? '' : 'none';
    }
    for (const lab of beltsCol.querySelectorAll('.belt-label')){
      const b = +lab.dataset.belt;
      lab.style.visibility = beltFilter.has(b) ? 'visible' : 'hidden';
    }
  }

  // ---------- Ruler (crisp & scroll-aware) ----------
  function resizeRuler(){
    const dpr = window.devicePixelRatio || 1;
    const cssW = scrollOuter.clientWidth;
    const cssH = 44;

    if (ruler._w !== cssW || ruler._h !== cssH || ruler._dpr !== dpr){
      ruler._w = cssW; ruler._h = cssH; ruler._dpr = dpr;
      ruler.width  = Math.round(cssW * dpr);
      ruler.height = Math.round(cssH * dpr);
      ruler.style.width  = cssW + 'px';
      ruler.style.height = cssH + 'px';
    }
  }

  function drawRuler(){
    const dpr = window.devicePixelRatio || 1;
    const ctx = ruler.getContext('2d');
    const W = ruler._w || scrollOuter.clientWidth;
    const H = ruler._h || 44;

    ctx.setTransform(dpr,0,0,dpr,0,0);
    ctx.clearRect(0,0,W,H);

    ctx.font = '12px system-ui';
    ctx.textBaseline = 'top';

    // visible time window
    const leftMin = scrollOuter.scrollLeft / pxPerMin;
    const viewStart = new Date(+windowStart + leftMin*60000);
    const viewEnd   = new Date(+viewStart + (W/pxPerMin)*60000);

    // minor ticks (15 min)
    const firstMinor = new Date(viewStart);
    const mm = firstMinor.getMinutes();
    firstMinor.setMinutes(mm + (15 - (mm % 15)) % 15, 0, 0);

    ctx.strokeStyle = 'rgba(255,255,255,.12)';
    for (let t=+firstMinor; t<=+viewEnd+15*60000; t+=15*60000){
      const x = ((t - +viewStart)/60000)*pxPerMin + 0.5;
      ctx.beginPath(); ctx.moveTo(x, H-18); ctx.lineTo(x, H); ctx.stroke();
    }

    // major ticks (hourly) + labels
    const firstMajor = new Date(viewStart);
    if (firstMajor.getMinutes() !== 0) {
      firstMajor.setHours(firstMajor.getHours()+1,0,0,0);
    } else {
      firstMajor.setMinutes(0,0,0);
    }

    ctx.strokeStyle = 'rgba(255,255,255,.25)';
    ctx.fillStyle = '#cfe0ff';
    for (let t=+firstMajor; t<=+viewEnd+3600e3; t+=3600e3){
      const x = ((t - +viewStart)/60000)*pxPerMin + 0.5;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
      const label = hhmm(new Date(t));
      ctx.fillText(label, x+6, 6);
    }
  }

  function placeNowLine(){
    nowLine.style.left = `${xForTime(new Date())}px`;
  }

  // ---------- Utils ----------
  function sevClass(r){
    const dm = typeof r.delay_min === 'number' ? r.delay_min : null;
    if (dm == null) return 'ok';
    if (dm >= 20) return 'd20';
    if (dm >= 10) return 'd10';
    if (dm <= -1) return 'early';
    return 'ok';
  }
  function xForTime(t){
    const min = (+t - +windowStart)/60000;
    return Math.round(min * pxPerMin);
  }
  function floorHour(d){
    const x = new Date(d);
    x.setMinutes(0,0,0);
    return x;
  }
  function pad(n){ return String(n).padStart(2,'0'); }
  function hhmm(d){ return `${pad(d.getHours())}:${pad(d.getMinutes())}`; }
  function hhmmLocal(isoOrDate){
    const d = (isoOrDate instanceof Date) ? isoOrDate : new Date(isoOrDate);
    return hhmm(d);
  }
  function isoDay(d){
    return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
  }

  async function getJSON(path){
    const res = await fetch(`${path}?v=${Date.now()}`, {cache:'no-store'});
    return res.ok ? res.json() : {};
  }
  function readHist(){
    try{ return JSON.parse(localStorage.getItem('brs_timeline_hist')||'{}'); }catch{ return {}; }
  }
  function writeHist(obj){
    try{ localStorage.setItem('brs_timeline_hist', JSON.stringify(obj)); }catch{}
  }

  // tiny helper to redraw after zoom changes
  function redrawAll(){
    // re-render positions only (keep current items)
    const hist = Object.values(readHist());
    renderGrid(hist);
    resizeRuler(); drawRuler(); placeNowLine();
  }
})();
