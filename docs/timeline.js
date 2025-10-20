/* docs/timeline.js — horizontally scrollable timeline */

(() => {
  // ---------- CONFIG ----------
  const DEFAULT_PX_PER_MIN = 6;
  const BACK_HOURS  = 5;  // history
  const AHEAD_HOURS = 6;  // future
  const GRID_TICK_MIN   = 15;
  const GRID_LABEL_MIN  = 30;
  const HISTORY_FADE_MIN = 60; // >60 min behind start → fade

  const ALL_BELTS = [1,2,3,5,6,7];

  // ---------- ELEMENTS ----------
  const scroller = document.getElementById('tl-scroller');
  const canvas   = document.getElementById('tl-canvas');
  const meta     = document.getElementById('page-meta');

  const btnNow   = document.querySelector('[data-action="jump-now"]');
  const pxSelect = document.querySelector('[data-role="px-per-min"]');
  const beltButtons = Array.from(document.querySelectorAll('.chip[data-belt]'));
  const chipAll  = document.querySelector('.chip[data-filter="all"]');
  const chipNone = document.querySelector('.chip[data-filter="none"]');

  // ---------- STATE ----------
  let pxPerMin = Number(pxSelect?.value || DEFAULT_PX_PER_MIN);
  let activeBelts = new Set(ALL_BELTS);  // filtered belts

  // data
  let rows = [];
  let generatedAt = '';
  // window
  let t0, t1, totalMin, widthPx;

  // ---------- UTILS ----------
  const pad = n => String(n).padStart(2,'0');
  const hhmm = d => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const minutesBetween = (a,b) => Math.round((b - a)/60000);
  const parseISO = s => (s ? new Date(s) : null);
  const clamp = (x, min, max) => Math.max(min, Math.min(max, x));

  const minToX = m => m * pxPerMin;
  const xForDate = dt => minToX(minutesBetween(t0, dt));

  function colorClassForDelay(min){
    if (typeof min !== 'number') return 'puck-ontime';
    if (min >= 20) return 'puck-red';
    if (min >= 10) return 'puck-amber';
    if (min <= -1) return 'puck-early';
    return 'puck-ontime';
  }

  // ---------- DATA ----------
  async function loadData(){
    const res = await fetch(`assignments.json?v=${Date.now()}`);
    const data = await res.json();
    rows = Array.isArray(data.rows) ? data.rows : [];
    generatedAt = data.generated_at_local || data.generated_at_utc || '';
    if (meta) meta.textContent = `Generated ${generatedAt} • Horizon ${data.horizon_minutes || ''} min`;
  }

  // ---------- RENDER ----------
  function buildWindow(){
    const now = new Date();
    t0 = new Date(now.getTime() - BACK_HOURS*60*1000);
    t1 = new Date(now.getTime() + AHEAD_HOURS*60*1000);
    totalMin = minutesBetween(t0, t1);
    widthPx = totalMin * pxPerMin;
    canvas.style.width = `${widthPx}px`;
  }

  function clearCanvas(){
    canvas.innerHTML = '';
  }

  function renderGrid(){
    const grid = document.createDocumentFragment();

    for (let m=0; m<= totalMin; m += GRID_TICK_MIN){
      const x = minToX(m);

      const t = document.createElement('div');
      t.className = 'tick';
      t.style.left = `${x}px`;
      grid.appendChild(t);

      if (m % GRID_LABEL_MIN === 0){
        const d = new Date(t0.getTime() + m*60000);
        const lbl = document.createElement('div');
        lbl.className = 'tick-label';
        lbl.style.left = `${x}px`;
        lbl.textContent = hhmm(d);
        grid.appendChild(lbl);
      }
    }

    canvas.appendChild(grid);
  }

  function activeBeltArray(){ return ALL_BELTS.filter(b => activeBelts.has(b)); }

  function renderBelts(){
    const belts = activeBeltArray();
    const rowH = Math.max(90, Math.floor((scroller.clientHeight - 30) / Math.max(1, belts.length)));

    belts.forEach((belt, i) => {
      const yTop = 60 + i*rowH;

      const stripe = document.createElement('div');
      stripe.className = 'belt-stripe';
      stripe.style.top = `${yTop-22}px`;
      stripe.style.height = `${rowH-14}px`;
      canvas.appendChild(stripe);

      const name = document.createElement('div');
      name.className = 'belt-name';
      name.style.top = `${yTop-38}px`;
      name.textContent = `Belt ${belt}`;
      canvas.appendChild(name);
    });

    return { rowH, belts };
  }

  function yForBelt(belt, rowH, belts){
    const idx = belts.indexOf(Number(belt));
    if (idx < 0) return null;
    return 60 + idx*rowH - 8; // center puck vertically in the band
    }

  function renderNowLine(){
    const nowX = xForDate(new Date());
    const line = document.createElement('div');
    line.className = 'tl-now-line';
    line.dataset.role = 'now-line';
    line.style.left = `${nowX}px`;
    canvas.appendChild(line);
  }

  function renderPucks(rowH, belts){
    const now = new Date();

    rows.forEach(r => {
      if (!r.start || !r.end || !r.belt) return;
      if (!activeBelts.has(Number(r.belt))) return;

      const start = parseISO(r.start);
      const end   = parseISO(r.end);
      const y = yForBelt(r.belt, rowH, belts);
      if (y == null) return;

      const left  = clamp(xForDate(start), 0, widthPx);
      const right = clamp(xForDate(end),   0, widthPx);
      const width = Math.max(34, right - left);

      const p = document.createElement('div');
      p.className = `puck ${colorClassForDelay(r.delay_min)}`;
      p.style.left = `${left}px`;
      p.style.top  = `${y}px`;
      p.style.width = `${width}px`;

      // fade old history (> 60 min behind belt start time)
      const minsBehind = minutesBetween(start, now);
      if (minsBehind > HISTORY_FADE_MIN){
        p.style.opacity = '.35';
        p.style.filter  = 'grayscale(60%)';
      }

      const origin = (r.origin_iata || '').replace(/[()]/g,'');
      const code   = r.flight || '—';
      p.textContent = `${code} • ${origin}`;

      p.title = [
        `Scheduled → ETA: ${(r.scheduled_local || '—')} → ${(r.eta_local || '—')}`,
        `Status: ${r.status || '—'}`,
        `Flow: ${r.flow || '—'}`,
        `Belt: ${r.belt}`,
        `Start–End: ${hhmm(parseISO(r.start))} – ${hhmm(parseISO(r.end))}`,
        `Reason: ${r.reason || '—'}`
      ].join('\n');

      canvas.appendChild(p);
    });
  }

  async function renderAll(){
    await loadData();
    clearCanvas();
    buildWindow();
    renderGrid();
    const { rowH, belts } = renderBelts();
    renderPucks(rowH, belts);
    renderNowLine();
  }

  // ---------- INTERACTION ----------
  function centerNow(animated=true){
    const nowX = xForDate(new Date());
    const center = nowX - scroller.clientWidth/2;
    if (!animated) scroller.style.scrollBehavior = 'auto';
    scroller.scrollLeft = clamp(center, 0, Math.max(0, widthPx - scroller.clientWidth));
    if (!animated) setTimeout(() => scroller.style.scrollBehavior = 'smooth', 0);
  }

  // Wheel horizontal scroll (Shift = faster)
  scroller.addEventListener('wheel', (e) => {
    e.preventDefault();
    const delta = (e.deltaY || e.deltaX) * (e.shiftKey ? 2 : 1);
    scroller.scrollLeft += delta;
  }, { passive:false });

  // Grab-to-pan
  let drag = { active:false, startX:0, startLeft:0 };
  scroller.addEventListener('mousedown', (e) => {
    drag = { active:true, startX:e.clientX, startLeft: scroller.scrollLeft };
    scroller.classList.add('grabbing');
  });
  window.addEventListener('mousemove', (e) => {
    if (!drag.active) return;
    const dx = e.clientX - drag.startX;
    scroller.scrollLeft = drag.startLeft - dx;
  });
  window.addEventListener('mouseup', () => {
    drag.active = false;
    scroller.classList.remove('grabbing');
  });

  // Keyboard navigation
  window.addEventListener('keydown', (e) => {
    const small = 120, big = scroller.clientWidth * 0.6;
    if (e.key === 'ArrowLeft')  scroller.scrollLeft -= (e.shiftKey ? big : small);
    if (e.key === 'ArrowRight') scroller.scrollLeft += (e.shiftKey ? big : small);
  });

  // Zoom control
  pxSelect?.addEventListener('change', async () => {
    pxPerMin = Number(pxSelect.value || DEFAULT_PX_PER_MIN);
    await renderAll();
    centerNow(false);
  });

  // Now button
  btnNow?.addEventListener('click', () => centerNow(true));

  // Belt filters
  function syncBeltChips(){
    beltButtons.forEach(b => {
      const val = Number(b.dataset.belt);
      b.classList.toggle('active', activeBelts.has(val));
    });
    chipAll?.classList.toggle('active', activeBelts.size === ALL_BELTS.length);
    chipNone?.classList.toggle('active', activeBelts.size === 0);
  }
  beltButtons.forEach(btn => {
    btn.addEventListener('click', async () => {
      const val = Number(btn.dataset.belt);
      if (activeBelts.has(val)) activeBelts.delete(val);
      else activeBelts.add(val);
      syncBeltChips();
      await renderAll();
    });
  });
  chipAll?.addEventListener('click', async () => {
    activeBelts = new Set(ALL_BELTS);
    syncBeltChips(); await renderAll();
  });
  chipNone?.addEventListener('click', async () => {
    activeBelts = new Set();
    syncBeltChips(); await renderAll();
  });

  // Keep “Now” line accurate
  setInterval(() => {
    const line = canvas.querySelector('[data-role="now-line"]');
    if (!line) return;
    line.style.left = `${xForDate(new Date())}px`;
  }, 60_000);

  // Refresh data every minute without jank
  setInterval(renderAll, 60_000);

  // Re-layout on resize
  window.addEventListener('resize', async () => {
    await renderAll();
  });

  // ---------- INIT ----------
  (async function init(){
    syncBeltChips();
    await renderAll();
    centerNow(false);
  })();

})();
