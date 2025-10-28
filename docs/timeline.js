/* docs/timeline.js
 * Simple, robust renderer for timeline.html (no external libs).
 * - Works with #zoom, #nowBtn, #beltChips, #ruler (canvas), #rows, #nowLine.
 * - Keeps belts 1,2,3,5,6,7 visible even when empty.
 * - Pucks align to the TOP of their lane (small translateY tweak).
 * - Minimum zoom is 8 px/min (clamped).
 * - Past pucks (ended >2 min ago) are shown with class "done".
 * - Lane packing uses 1 minute separation so near-adjacent flights stack vertically.
 */

(function () {
  // ---------- DOM ----------
  const $ = (s, el = document) => el.querySelector(s);
  const CE = (tag, cls) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    return n;
  };

  const beltChips   = $('#beltChips');
  const zoomSel     = $('#zoom');
  const nowBtn      = $('#nowBtn');
  const meta        = $('#meta');

  const scrollOuter = $('#scrollOuter');
  const scrollInner = $('#scrollInner');
  const rowsHost    = $('#rows');
  const rulerCanvas = /** @type {HTMLCanvasElement} */($('#ruler'));
  const nowLine     = $('#nowLine');

  // ---------- Constants / State ----------
  const BELTS = [1, 2, 3, 5, 6, 7];
  const MIN_PX_PER_MIN = 8;                // clamp zoom (as requested)
  const MIN_SEPARATION_MS = 1 * 60 * 1000; // 1 minute separation between pucks in a lane
  const DONE_GRACE_MS = 2 * 60 * 1000;     // show "done" only once end is > 2 minutes in the past
  const minute = 60 * 1000;

  let flights = [];
  let assignments = null;
  let beltFilter = new Set(); // empty => all
  let pxPerMin = clampPxPerMin(parseFloat(zoomSel?.value || '8'));
  let timeMin = null, timeMax = null; // Date

  // read CSS custom properties (fallbacks keep it safe)
  const cssNum = (name, fallback) => {
    const v = parseInt(getComputedStyle(document.documentElement).getPropertyValue(name), 10);
    return Number.isFinite(v) ? v : fallback;
  };
  const LANE_H   = cssNum('--lane-height', 58);
  const LANE_GAP = cssNum('--lane-gap', 10);
  const BELT_PAD = cssNum('--belt-pad-y', 18);

  // ---------- Utilities ----------
  function clampPxPerMin(v) {
    if (!Number.isFinite(v)) return MIN_PX_PER_MIN;
    return Math.max(MIN_PX_PER_MIN, v);
  }
  function xForDate(d) {
    return ((+new Date(d)) - (+timeMin)) / 60000 * pxPerMin;
  }
  function pad(n) { return String(n).padStart(2, '0'); }
  function hhmm(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function fetchJSON(u) {
    return fetch(u, { cache: 'no-store' }).then(r => r.json());
  }

  // ---------- Load ----------
  function load() {
    return fetchJSON('assignments.json?v=' + Date.now()).then(data => {
      assignments = data;
      flights = Array.isArray(data.rows) ? data.rows.slice() : [];

      // time window
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

      if (meta) {
        const when = assignments.generated_at_local || assignments.generated_at_utc || '';
        const hor  = assignments.horizon_minutes || '';
        meta.textContent = `Generated ${when} • Horizon ${hor} min`;
      }

      buildBeltChips();
      drawAll();
    });
  }

  // ---------- Belt chips ----------
  function buildBeltChips() {
    if (!beltChips) return;
    beltChips.innerHTML = '';
    const frag = document.createDocumentFragment();

    const mk = (label, key) => {
      const b = CE('button', 'chip');
      b.textContent = label;
      b.dataset.key = key;
      b.addEventListener('click', () => toggleFilter(key));
      frag.appendChild(b);
    };

    BELTS.forEach(b => mk(`Belt ${b}`, String(b)));
    mk('All', 'all');
    mk('None', 'none');

    beltChips.appendChild(frag);
    updateChipVisuals();
  }

  function toggleFilter(key) {
    if (key === 'all') beltFilter.clear();
    else if (key === 'none') beltFilter = new Set(['__none__']);
    else {
      const n = parseInt(key, 10);
      if (Number.isFinite(n)) {
        if (beltFilter.has(n)) beltFilter.delete(n);
        else beltFilter.add(n);
      }
    }
    updateChipVisuals();
    drawAll();
  }

  function updateChipVisuals() {
    if (!beltChips) return;
    [...beltChips.querySelectorAll('.chip')].forEach(c => {
      const k = c.dataset.key;
      const on =
        (k === 'all'  && beltFilter.size === 0) ||
        (k === 'none' && beltFilter.has('__none__')) ||
        (/^\d+$/.test(k) && beltFilter.has(parseInt(k, 10)));
      c.classList.toggle('on', on);
    });
  }

  // ---------- Ruler (hour + 10-min faint) ----------
  function drawRuler() {
    if (!rulerCanvas) return;
    const ctx = rulerCanvas.getContext('2d');
    const width  = Math.max(xForDate(timeMax) + 200, scrollOuter.clientWidth);
    const height = 46;
    const dpr = window.devicePixelRatio || 1;

    rulerCanvas.width  = Math.floor(width  * dpr);
    rulerCanvas.height = Math.floor(height * dpr);
    rulerCanvas.style.width  = `${width}px`;
    rulerCanvas.style.height = `${height}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // background strip
    const panel = getCSS('--panel', '#111b26');
    ctx.fillStyle = panel;
    ctx.fillRect(0, 0, width, height);

    // hour ticks + labels
    const startHour = new Date(timeMin);
    startHour.setMinutes(0, 0, 0);

    // 10-min faint lines (just on ruler)
    ctx.fillStyle = getCSS('--grid-faint', '#14212f');
    for (let t = +startHour; t <= +timeMax; t += 10 * minute) {
      const x = Math.floor(xForDate(t));
      ctx.fillRect(x, height - 20, 1, 10);
    }

    // hour lines and labels
    ctx.fillStyle = getCSS('--grid', '#1b2a39');
    for (let t = +startHour; t <= +timeMax; t += 60 * minute) {
      const x = Math.floor(xForDate(t));
      ctx.fillRect(x, 0, 1, height);
      // label
      ctx.fillStyle = getCSS('--text', '#dce6f2');
      ctx.font = '14px system-ui, -apple-system, Segoe UI, Roboto, Arial';
      ctx.textBaseline = 'middle';
      ctx.fillText(hhmm(t), x + 8, 14);
      ctx.fillStyle = getCSS('--grid', '#1b2a39');
    }
  }

  function getCSS(name, fallback) {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name);
    return v && v.trim() ? v.trim() : fallback;
  }

  // ---------- Grid (verticals behind rows) ----------
  function drawGridLines(totalHeight) {
    // remove old
    [...scrollInner.querySelectorAll('.gridline')].forEach(x => x.remove());

    const startHour = new Date(timeMin);
    startHour.setMinutes(0, 0, 0);

    const frag = document.createDocumentFragment();

    // faint 10-min verticals
    for (let t = +startHour; t <= +timeMax; t += 10 * minute) {
      const x = xForDate(t);
      const g = CE('div', 'gridline faint');
      g.style.left = `${x}px`;
      g.style.height = `${totalHeight}px`;
      frag.appendChild(g);
    }

    // stronger hour verticals
    for (let t = +startHour; t <= +timeMax; t += 60 * minute) {
      const x = xForDate(t);
      const g = CE('div', 'gridline strong');
      g.style.left = `${x}px`;
      g.style.height = `${totalHeight}px`;
      frag.appendChild(g);
    }

    scrollInner.appendChild(frag);
  }

  // ---------- Lane packing (1-minute separation) ----------
  function packLanes(items) {
    const sorted = items.slice().sort((a, b) => +new Date(a.start) - +new Date(b.start));
    const lanesLastEnd = []; // ms
    for (const f of sorted) {
      const s = +new Date(f.start), e = +new Date(f.end);
      let lane = -1;
      for (let i = 0; i < lanesLastEnd.length; i++) {
        if (s >= (lanesLastEnd[i] + MIN_SEPARATION_MS)) { lane = i; break; }
      }
      if (lane === -1) { lane = lanesLastEnd.length; lanesLastEnd.push(e); }
      else lanesLastEnd[lane] = e;
      f._lane = lane;
    }
    return { lanes: Math.max(1, lanesLastEnd.length), items: sorted };
  }

  // ---------- Build puck ----------
  function buildPuck(r) {
    const p = CE('div', `puck ${classByDelay(r.delay_min)} ${isDone(r) ? 'done' : ''}`);

    // title: Flight • ORG (IATA)
    const title = CE('div', 'title');
    const origin = (r.origin_iata || r.origin || '').toString().trim();
    title.textContent = `${(r.flight || '').trim()} • ${origin}`.replace(/\s+/g, ' ');

    // sub: scheduled → eta (when available)
    const sub = CE('div', 'sub');
    const eta = r.eta_local || hhmm(r.eta);
    const sch = r.scheduled_local || '';
    sub.textContent = sch ? `${sch} → ${eta}` : eta;

    p.appendChild(title);
    p.appendChild(sub);

    // position (horizontal)
    const left = xForDate(r.start);
    const right = xForDate(r.end);
    p.style.left = `${left}px`;
    p.style.width = `${Math.max(120, right - left - 4)}px`;

    // position (vertical lane) — ALIGN TO TOP (requested)
    p.style.top = `${r._lane * (LANE_H + LANE_GAP)}px`;
    p.style.transform = 'translateY(-10%)'; // <— small lift to sit at the top grid line

    // tooltip
    const tip = [
      `${(r.flight || '').trim()} ${r.origin ? \`• ${r.origin}\` : ''}`.trim(),
      `${hhmm(r.start)} → ${hhmm(r.end)}`,
      r.flow || '',
      r.airline || '',
      r.aircraft || '',
      r.reason ? \`Reason: ${r.reason}\` : ''
    ].filter(Boolean).join('\n');
    p.setAttribute('data-tip', tip);

    return p;
  }

  function classByDelay(d) {
    if (d == null) return 'ok';
    if (d >= 20) return 'late';
    if (d >= 10) return 'mid';
    if (d <= -1)  return 'early';
    return 'ok';
  }

  function isDone(r) {
    const ended = +new Date(r.end);
    return (Date.now() - ended) > DONE_GRACE_MS;
  }

  // ---------- Draw rows & pucks ----------
  function drawRows() {
    rowsHost.innerHTML = '';
    const beltsToShow = BELTS.filter(b => beltFilter.size === 0 || beltFilter.has(b));
    const frag = document.createDocumentFragment();
    let totalHeight = 0;

    for (const b of beltsToShow) {
      const row = CE('div', 'belt-row');
      const name = CE('div', 'belt-name'); name.textContent = `Belt ${b}`;
      const inner = CE('div', 'row-inner');

      row.appendChild(name);
      row.appendChild(inner);

      const items = flights.filter(r => r.belt === b);
      const { lanes, items: packed } = packLanes(items);

      const contentH = lanes * (LANE_H + LANE_GAP) - LANE_GAP;
      row.style.minHeight = `calc(${BELT_PAD}px * 2 + ${Math.max(0, contentH)}px)`;
      packed.forEach(r => inner.appendChild(buildPuck(r)));

      frag.appendChild(row);
      totalHeight += row.getBoundingClientRect().height;
    }

    rowsHost.appendChild(frag);

    // scrollable width covering the time range
    const width = Math.max(xForDate(timeMax) + 200, scrollOuter.clientWidth);
    scrollInner.style.width = `${width}px`;

    drawGridLines(totalHeight);
    updateNowLine(totalHeight);
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

  // ---------- Interactions ----------
  zoomSel?.addEventListener('change', () => {
    pxPerMin = clampPxPerMin(parseFloat(zoomSel.value || '8'));
    drawAll();
  });

  nowBtn?.addEventListener('click', () => {
    const nowX = xForDate(Date.now());
    const viewW = scrollOuter.clientWidth;
    scrollOuter.scrollLeft = Math.max(0, nowX - viewW / 2);
  });

  window.addEventListener('resize', drawAll);
  setInterval(() => updateNowLine(rowsHost.getBoundingClientRect().height || 0), 30 * 1000);

  // light auto-refresh (keeps page stable)
  setInterval(() => {
    fetch('assignments.json?v=' + Date.now(), { cache: 'no-store' })
      .then(r => r.json())
      .then(d => {
        if (!d) return;
        const prev = assignments?.generated_at_utc;
        assignments = d;
        flights = Array.isArray(d.rows) ? d.rows.slice() : [];
        if (d.generated_at_utc !== prev) {
          load(); // time window might shift
        } else {
          drawAll();
        }
      })
      .catch(() => {});
  }, 90 * 1000);

  // ---------- Boot ----------
  load().then(() => {
    // Center near "now" on first paint
    const nowX = xForDate(Date.now());
    const viewW = scrollOuter.clientWidth;
    scrollOuter.scrollLeft = Math.max(0, nowX - viewW / 2);
  });

})();
