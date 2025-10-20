/* docs/timeline.js
 * Works with the HTML you pasted (viewport/scrollOuter/scrollInner/canvas ruler/etc).
 * Visuals unchanged. Tweak: lane is free only if next start >= lastEnd + 45 min.
 */

(function () {
  // ------- helpers -------
  const $ = (s) => document.querySelector(s);
  const el = (tag, cls) => { const n = document.createElement(tag); if (cls) n.className = cls; return n; };
  const minute = 60 * 1000;
  const dFmt = (d) => { const dt = new Date(d); return `${String(dt.getHours()).padStart(2,'0')}:${String(dt.getMinutes()).padStart(2,'0')}`; };

  // ------- DOM (matches your HTML) -------
  const beltChips   = $('#beltChips');
  const zoomSel     = $('#zoom');
  const nowBtn      = $('#nowBtn');
  const meta        = $('#meta');

  const viewport    = $('#viewport');
  const scrollOuter = $('#scrollOuter');
  const scrollInner = $('#scrollInner');
  const rowsHost    = $('#rows');          // container for belt rows & pucks
  const canvasRuler = /** @type {HTMLCanvasElement} */($('#ruler'));
  const nowLine     = $('#nowLine');       // absolutely positioned vertical line

  // ------- state -------
  const BELTS_ORDER = [1,2,3,5,6,7];
  let assignments = null;
  let flights = [];
  let pxPerMin = parseFloat(zoomSel?.value || '6'); // keep your default 6 px/min
  let timeMin = null, timeMax = null;               // Date
  let beltFilter = new Set();                       // empty => show all
  const MIN_SEPARATION_MS = 45 * minute;            // <— the only behavioural tweak

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

  function load() {
    return fetchJSON('assignments.json').then(data => {
      assignments = data;
      flights = (data.rows || []).slice();

      // time window padding
      if (flights.length) {
        const starts = flights.map(r => +new Date(r.start || r.eta));
        const ends   = flights.map(r => +new Date(r.end   || r.eta));
        const padMin = 45 * minute;
        timeMin = new Date(Math.min(...starts) - padMin);
        timeMax = new Date(Math.max(...ends)   + padMin);
      } else {
        const now = Date.now();
        timeMin = new Date(now - 90 * minute);
        timeMax = new Date(now + 90 * minute);
      }

      if (meta) meta.textContent = `Generated ${assignments.generated_at_local} • Horizon ${assignments.horizon_minutes} min`;

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
        if (s >= (lanesLastEnd[i] + MIN_SEPARATION_MS)) { lane = i; break; }
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

    ctx.clearRect(0,0,width,height);
    ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--panel') || '#111b26';
    ctx.fillRect(0,0,width,height);

    ctx.strokeStyle = '#1a2a3a';
    ctx.beginPath(); ctx.moveTo(0,height-1); ctx.lineTo(width,height-1); ctx.stroke();

    ctx.fillStyle = '#dce6f2';
    ctx.font = '14px ui-sans-serif, system-ui, Segoe UI, Roboto, Arial';
    ctx.textBaseline = 'alphabetic';

    // hour ticks
    const start = new Date(timeMin); start.setMinutes(0,0,0);
    for (let t = +start; t <= +timeMax; t += 60*minute) {
      const x = Math.floor(xForDate(t));
      // tick
      ctx.fillStyle = '#213043';
      ctx.fillRect(x, 0, 1, height);
      // label
      ctx.fillStyle = '#dce6f2';
      ctx.fillText(dFmt(t), x + 8, height - 12);
    }
  }

  function buildPuck(f) {
    const p = el('div', `puck ${classByDelay(f.delay_min)}`);
    const title = el('div','title'); title.textContent = `${(f.flight||'').trim()} • ${(f.origin_iata||'').trim() || f.origin || ''}`.replace(/\s+/g,' ');
    const sub    = el('div','sub');   sub.textContent   = `${dFmt(f.start)} → ${dFmt(f.end)}`;

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

  function classByDelay(d) {
    if (d == null) return 'ok';
    if (d >= 20) return 'late';
    if (d >= 10) return 'mid';
    if (d <= -1)  return 'early';
    return 'ok';
  }

  function drawRows() {
    rowsHost.innerHTML = '';
    const frag = document.createDocumentFragment();

    let totalHeight = 0;
    const beltsToShow = BELTS_ORDER.filter(b => beltFilter.size === 0 || beltFilter.has(b));

    // per belt
    for (const b of beltsToShow) {
      const beltRow = el('div','belt-row');
      const beltName = el('div','belt-name'); beltName.textContent = `Belt ${b}`;
      const inner = el('div','row-inner');

      beltRow.appendChild(beltName);
      beltRow.appendChild(inner);

      const items = flights.filter(r => r.belt === b);
      const { lanes, items: packed } = packLanes(items);

      const contentH = lanes * (LANE_H + LANE_GAP) - LANE_GAP; // last lane no gap
      beltRow.style.minHeight = `calc(${BELT_PAD}px * 2 + ${contentH}px)`;

      for (const f of packed) inner.appendChild(buildPuck(f));

      frag.appendChild(beltRow);
      // add height after measuring
      totalHeight += beltRow.getBoundingClientRect().height;
    }

    rowsHost.appendChild(frag);

    // resize scroll area width to fit timeline
    const width = Math.max(xForDate(timeMax) + 200, scrollOuter.clientWidth);
    scrollInner.style.width = `${width}px`;

    // vertical hour gridlines (behind rows)
    addGridlines(totalHeight);

    // position/update Now line
    updateNowLine(totalHeight);
  }

  function addGridlines(totalHeight) {
    // remove previous
    [...scrollInner.querySelectorAll('.gridline')].forEach(x => x.remove());
    const start = new Date(timeMin); start.setMinutes(0,0,0);
    const frag = document.createDocumentFragment();
    for (let t = +start; t <= +timeMax; t += 60*minute) {
      const x = xForDate(t);
      const g = el('div','gridline');
      g.style.left = `${x}px`;
      g.style.height = `${totalHeight}px`;
      frag.appendChild(g);
    }
    scrollInner.appendChild(frag);
  }

  function updateNowLine(totalHeight) {
    if (!nowLine) return;
    nowLine.style.left = `${xForDate(Date.now())}px`;
    nowLine.style.height = `${totalHeight}px`;
  }

  function drawAll() {
    drawRuler();
    drawRows();
  }

  // ------- interactions -------
  zoomSel?.addEventListener('change', () => { pxPerMin = parseFloat(zoomSel.value || '6'); drawAll(); });
  nowBtn?.addEventListener('click', () => {
    const nowX = xForDate(Date.now());
    const viewW = scrollOuter.clientWidth;
    scrollOuter.scrollLeft = Math.max(0, nowX - viewW/2);
  });

  // keep ruler aligned with content
  scrollOuter.addEventListener('scroll', () => {
    // ruler is a canvas spanning the same scrollable width, so no translate needed,
    // we only keep the "Now" line visually in place.
    // (If you later pin the canvas, you can sync translateX here.)
  });
  window.addEventListener('resize', drawAll);
  // small timer to keep the "Now" line creeping without full redraw
  setInterval(() => updateNowLine(rowsHost.getBoundingClientRect().height || 0), 30 * 1000);

  // ------- live refresh every ~90s (as before) -------
  setInterval(() => {
    fetch('assignments.json', { cache: 'no-store' })
      .then(r => r.json())
      .then(data => {
        if (!data) return;
        const prev = assignments?.generated_at_utc;
        assignments = data;
        flights = (data.rows || []).slice();
        if (data.generated_at_utc !== prev) {
          load();     // window may shift
        } else {
          drawAll();  // same window, just redraw
        }
      }).catch(()=>{});
  }, 90 * 1000);

  // ------- boot -------
  load().then(() => {
    // center near now on first paint
    const nowX = xForDate(Date.now());
    const viewW = scrollOuter.clientWidth;
    scrollOuter.scrollLeft = Math.max(0, nowX - viewW/2);
  });
})();
