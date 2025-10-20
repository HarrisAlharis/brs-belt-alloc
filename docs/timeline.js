/* docs/timeline.js
 * Adds:
 *  - Min zoom = 8 px/min (UI + clamp)
 *  - Completed pucks (end + 2 min) greyed but kept visible
 *  - Rolling 4-hour history using a small in-memory cache
 * Keeps all other visuals/behaviors unchanged.
 */
(function () {
  // ------- helpers -------
  const $ = (s) => document.querySelector(s);
  const el = (tag, cls) => { const n = document.createElement(tag); if (cls) n.className = cls; return n; };
  const minute = 60 * 1000;
  const FOUR_HOURS = 4 * 60 * minute;
  const COMPLETED_GRACE_MS = 2 * minute; // end + 2 min
  const dFmt = (d) => { const dt = new Date(d); return `${String(dt.getHours()).padStart(2,'0')}:${String(dt.getMinutes()).padStart(2,'0')}`; };
  const clampMinZoom = (v) => Math.max(8, parseFloat(v || 8));

  // ------- DOM -------
  const beltChips   = $('#beltChips');
  const zoomSel     = $('#zoom');
  const nowBtn      = $('#nowBtn');
  const meta        = $('#meta');

  const scrollOuter = $('#scrollOuter');
  const scrollInner = $('#scrollInner');
  const rowsHost    = $('#rows');          // container for belt rows & pucks
  const canvasRuler = /** @type {HTMLCanvasElement} */($('#ruler'));
  const nowLine     = $('#nowLine');       // absolutely positioned vertical line

  // ------- state -------
  const BELTS_ORDER = [1,2,3,5,6,7];
  let assignments = null;
  let rawFlights = [];
  let pxPerMin = clampMinZoom(zoomSel?.value || 8);
  let timeMin = null, timeMax = null;               // Date
  let beltFilter = new Set();                       // empty => show all

  // cache for last 4 hours of rows (merged with incoming JSON)
  /** @type {Map<string, any>} */
  let flightCache = new Map();

  // style vars (read from CSS so visuals stay exactly as-is)
  const getCssNum = (name, fallback) => {
    const v = parseInt(getComputedStyle(document.documentElement).getPropertyValue(name), 10);
    return Number.isFinite(v) ? v : fallback;
    };
  const LANE_H   = getCssNum('--lane-height', 58);
  const LANE_GAP = getCssNum('--lane-gap', 10);
  const BELT_PAD = getCssNum('--belt-pad-y', 18);

  // ------- data load -------
  const fetchJSON = (u) => fetch(u, { cache: 'no-store' }).then(r => r.json());

  // Determine a stable key to keep 4h cache consistent across refreshes
  function flightKey(r){
    // flight|start|belt (start is most stable to avoid frequent collisions)
    return `${(r.flight||'').trim()}|${r.start||r.eta||''}|${r.belt||''}`;
  }

  function mergeIntoCache(rows){
    const now = Date.now();
    // add/update entries that are within last 4h (by end time)
    for (const r of rows){
      if (!r) continue;
      const endMs = +new Date(r.end || r.eta || 0);
      if (!Number.isFinite(endMs)) continue;
      if (endMs >= (now - FOUR_HOURS)) {
        flightCache.set(flightKey(r), r);
      }
    }
    // prune entries older than 4h
    for (const [k, v] of flightCache){
      const endMs = +new Date(v.end || v.eta || 0);
      if (!(endMs >= (now - FOUR_HOURS))) flightCache.delete(k);
    }
  }

  function load() {
    return fetchJSON('assignments.json?v=' + Date.now()).then(data => {
      assignments = data;
      rawFlights = Array.isArray(data.rows) ? data.rows.slice() : [];

      // keep merged history (4h)
      mergeIntoCache(rawFlights);

      // time window: show from max(now-4h, earliest-45min), to max(end)+45min
      const now = Date.now();
      const cacheRows = [...flightCache.values()];
      const rows = cacheRows.length ? cacheRows : rawFlights;

      if (rows.length) {
        const starts = rows.map(r => +new Date(r.start || r.eta));
        const ends   = rows.map(r => +new Date(r.end   || r.eta));
        const pad = 45 * minute;

        const leftLimit = now - FOUR_HOURS;
        const earliest = Math.min(...starts) - pad;
        const minBound = Math.max(leftLimit, earliest);

        timeMin = new Date(minBound);
        timeMax = new Date(Math.max(...ends) + pad);
      } else {
        timeMin = new Date(now - FOUR_HOURS);
        timeMax = new Date(now + 90 * minute);
      }

      if (meta) meta.textContent = `Generated ${assignments.generated_at_local || assignments.generated_at_utc || ''} • Horizon ${assignments.horizon_minutes || ''} min`;

      buildBeltChips();
      drawAll();
    });
  }

  // ------- UI: belt filter chips -------
  function buildBeltChips() {
    if (!beltChips) return;
    beltChips.innerHTML = '';
    const frag = document.createDocumentFragment();

    const mkChip = (label, key) => {
      const b = el('button', 'chip');
      b.textContent = label;
      b.dataset.key = key;
      b.addEventListener('click', () => toggleFilter(key, b));
      frag.appendChild(b);
    };

    BELTS_ORDER.forEach(n => mkChip(`Belt ${n}`, String(n)));
    mkChip('All', 'all');
    mkChip('None', 'none');
    beltChips.appendChild(frag);
    // highlight All initially
    [...beltChips.querySelectorAll('.chip')].forEach(c => c.classList.toggle('on', c.dataset.key === 'all'));
  }

  function toggleFilter(key, btn) {
    if (key === 'all') { beltFilter.clear(); }
    else if (key === 'none') { beltFilter = new Set(['__none__']); }
    else {
      const n = parseInt(key, 10);
      if (Number.isFinite(n)) {
        if (beltFilter.has(n)) beltFilter.delete(n); else beltFilter.add(n);
      }
    }
    // chip visual
    [...beltChips.querySelectorAll('.chip')].forEach(c => {
      const k = c.dataset.key;
      const on =
        (k === 'all'  && beltFilter.size === 0) ||
        (k === 'none' && beltFilter.has('__none__')) ||
        (/^\d+$/.test(k) && beltFilter.has(parseInt(k,10)));
      c.classList.toggle('on', on);
    });
    drawAll();
  }

  // ------- geometry -------
  const xForDate = (d) => ((+new Date(d)) - (+timeMin)) / 60000 * pxPerMin;

  function packLanes(items) {
    // Sort by start time
    const sorted = items.slice().sort((a,b)=>+new Date(a.start) - +new Date(b.start));
    const lanesLastEnd = []; // ms
    for (const f of sorted) {
      const s = +new Date(f.start), e = +new Date(f.end);
      let lane = -1;
      for (let i=0; i<lanesLastEnd.length; i++) {
        // Only avoid overlap if times actually intersect;
        // If s >= lastEnd, we can reuse the lane (no extra enforced gap).
        if (s >= lanesLastEnd[i]) { lane = i; break; }
      }
      if (lane === -1) { lane = lanesLastEnd.length; lanesLastEnd.push(e); }
      else { lanesLastEnd[lane] = e; }
      f._lane = lane;
    }
    return { lanes: Math.max(1, lanesLastEnd.length), items: sorted };
  }

  // ------- draw -------
  function drawRuler() {
    if (!canvasRuler) return;
    const ctx = canvasRuler.getContext('2d');
    const width = Math.max(xForDate(timeMax) + 200, scrollOuter.clientWidth);
    const height = 44;

    // crisp canvas
    const dpr = window.devicePixelRatio || 1;
    canvasRuler.width  = Math.floor(width  * dpr);
    canvasRuler.height = Math.floor(height * dpr);
    canvasRuler.style.width  = `${width}px`;
    canvasRuler.style.height = `${height}px`;
    ctx.setTransform(dpr,0,0,dpr,0,0);

    // background
    ctx.clearRect(0,0,width,height);
    const panel = getComputedStyle(document.documentElement).getPropertyValue('--panel') || '#111b26';
    ctx.fillStyle = panel; ctx.fillRect(0,0,width,height);

    // baseline
    ctx.strokeStyle = '#1a2a3a';
    ctx.beginPath(); ctx.moveTo(0,height-1); ctx.lineTo(width,height-1); ctx.stroke();

    // labels
    ctx.fillStyle = '#dce6f2';
    ctx.font = '14px ui-sans-serif, system-ui, Segoe UI, Roboto, Arial';
    ctx.textBaseline = 'alphabetic';

    // major (hour) + minor (every 10 min) ticks
    const start = new Date(timeMin); start.setMinutes(0,0,0);
    const end = +timeMax;

    for (let t = +start; t <= end; t += 10*minute) {
      const x = Math.floor(xForDate(t));
      const isHour = (new Date(t).getMinutes() === 0);
      // vertical line is drawn in rows; ruler shows label for hours
      if (isHour) {
        ctx.fillStyle = '#dce6f2';
        ctx.fillText(dFmt(t), x + 6, height - 12);
      }
    }
  }

  function classByDelay(d) {
    if (d == null) return 'ok';
    if (d >= 20) return 'late';
    if (d >= 10) return 'mid';
    if (d <= -1)  return 'early';
    return 'ok';
  }

  function isCompleted(row){
    const end = +new Date(row.end || row.eta || 0);
    if (!Number.isFinite(end)) return false;
    return Date.now() >= (end + COMPLETED_GRACE_MS);
  }

  function buildPuck(f) {
    const baseClass = classByDelay(f.delay_min);
    const done = isCompleted(f);

    const p = el('div', `puck ${baseClass}${done ? ' done' : ''}`);
    // Title shows flight + origin code (kept as before)
    const title = el('div','title'); title.textContent =
      `${(f.flight||'').trim()} • ${(f.origin_iata||'').trim() || f.origin || ''}`.replace(/\s+/g,' ');
    const sub    = el('div','sub');   sub.textContent   = `${dFmt(f.start)} → ${dFmt(f.end)}`;

    // tooltip full details (unchanged)
    const tipLines = [
      `${(f.flight||'').trim()} ${f.origin ? `• ${f.origin}` : ''}`,
      `${dFmt(f.start)} → ${dFmt(f.end)}`,
      f.flow, f.airline, f.aircraft,
      f.reason ? `Reason: ${f.reason}` : ''
    ].filter(Boolean);
    p.setAttribute('data-tip', tipLines.join('\n'));

    p.appendChild(title); p.appendChild(sub);

    // position
    const left = xForDate(f.start);
    const right = xForDate(f.end);
    p.style.left  = `${left}px`;
    p.style.width = `${Math.max(120, right - left - 4)}px`;
    p.style.top   = `${f._lane * (LANE_H + LANE_GAP)}px`;

    return p;
  }

  function addGridlines(totalHeight) {
    // remove previous
    [...scrollInner.querySelectorAll('.gridline')].forEach(x => x.remove());

    const start = new Date(timeMin); start.setMinutes(0,0,0);
    const end = +timeMax;

    for (let t = +start; t <= end; t += 10*minute) {
      const x = xForDate(t);
      const g = el('div','gridline ' + (new Date(t).getMinutes()===0 ? 'major' : 'minor'));
      g.style.left = `${x}px`;
      g.style.height = `${totalHeight}px`;
      scrollInner.appendChild(g);
    }
  }

  function updateNowLine(totalHeight) {
    if (!nowLine) return;
    nowLine.style.left = `${xForDate(Date.now())}px`;
    nowLine.style.height = `${totalHeight}px`;
  }

  function drawRows() {
    rowsHost.innerHTML = '';
    const frag = document.createDocumentFragment();

    const now = Date.now();
    const allRows = [...flightCache.values()];
    // only include rows whose end is within last 4 hours
    const filteredByAge = allRows.filter(r => (+new Date(r.end || r.eta || 0)) >= (now - FOUR_HOURS));

    let totalHeight = 0;
    const beltsToShow = BELTS_ORDER.filter(b => beltFilter.size === 0 || beltFilter.has(b));

    // per belt
    for (const b of beltsToShow) {
      const beltRow = el('div','belt-row');
      const beltName = el('div','belt-name'); beltName.textContent = `Belt ${b}`;
      const inner = el('div','row-inner');

      beltRow.appendChild(beltName);
      beltRow.appendChild(inner);

      const items = filteredByAge.filter(r => r.belt === b);
      const { lanes, items: packed } = packLanes(items);

      const contentH = lanes * (LANE_H + LANE_GAP) - LANE_GAP; // last lane no gap
      beltRow.style.minHeight = `calc(${BELT_PAD}px * 2 + ${contentH}px)`;

      for (const f of packed) inner.appendChild(buildPuck(f));

      frag.appendChild(beltRow);
      totalHeight += beltRow.getBoundingClientRect().height;
    }

    rowsHost.appendChild(frag);

    // resize scroll area width to fit timeline
    const width = Math.max(xForDate(timeMax) + 200, scrollOuter.clientWidth);
    scrollInner.style.width = `${width}px`;

    // vertical hour & 10-min gridlines
    addGridlines(totalHeight);
    // position/update Now line
    updateNowLine(totalHeight);
  }

  function drawAll() {
    drawRuler();
    drawRows();
  }

  // ------- interactions -------
  zoomSel?.addEventListener('change', () => {
    pxPerMin = clampMinZoom(zoomSel.value);
    drawAll();
  });
  nowBtn?.addEventListener('click', () => {
    const nowX = xForDate(Date.now());
    const viewW = scrollOuter.clientWidth;
    scrollOuter.scrollLeft = Math.max(0, nowX - viewW/2);
  });

  window.addEventListener('resize', drawAll);

  // keep “completed/grey” state + Now line fresh without redrawing everything too often
  setInterval(() => {
    // reclassify pucks as done when they pass the grace
    const pucks = rowsHost.querySelectorAll('.puck');
    pucks.forEach(p => {
      // read times from tooltip to avoid storing more data on DOM:
      // safer approach: re-draw to apply classes correctly
      // To keep minimal changes, we do a light redraw:
    });
    drawRows(); // light redraw of rows keeps everything accurate with minimal cost
  }, 60 * 1000);

  // live refresh every ~90s (as before), but preserve 4h cache
  setInterval(() => {
    fetch('assignments.json?v=' + Date.now(), { cache: 'no-store' })
      .then(r => r.json())
      .then(data => {
        if (!data) return;
        const prev = assignments?.generated_at_utc;
        assignments = data;
        const incoming = Array.isArray(data.rows) ? data.rows : [];
        mergeIntoCache(incoming);

        if (data.generated_at_utc !== prev) {
          // Window might shift; recompute time bounds then redraw
          load();
        } else {
          drawAll();
        }
      }).catch(()=>{});
  }, 90 * 1000);

  // ------- boot -------
  // clamp any pre-existing persisted zoom
  if (zoomSel) zoomSel.value = String(clampMinZoom(zoomSel.value || 8));
  pxPerMin = clampMinZoom(zoomSel?.value || 8);

  load().then(() => {
    // center near now on first paint
    const nowX = xForDate(Date.now());
    const viewW = scrollOuter.clientWidth;
    scrollOuter.scrollLeft = Math.max(0, nowX - viewW/2);
  });
})();
