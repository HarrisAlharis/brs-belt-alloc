/* docs/timeline.js
 * Current working version.
 * Features:
 * - 8px/min minimum zoom
 * - belt filter chips
 * - packs flights into multiple vertical lanes if they overlap
 * - 4h rolling historical memory in browser
 * - greys/“completed” styling for flights whose belt window finished >2 min ago
 * - draws “Completed (past)” legend dot
 * - keeps belts 1..7 always visible
 * - draws hour grid lines + now line
 */

(function () {
  // ------- helpers -------
  const $ = (s, el = document) => el.querySelector(s);
  const el = (tag, cls) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    return n;
  };

  const MINUTE_MS = 60 * 1000;
  const HISTORY_WINDOW_MS = 4 * 60 * MINUTE_MS;        // 4h lookback
  const COMPLETED_GRACE_MS = 2 * MINUTE_MS;            // 2 min after belt_end => "completed"

  const BELTS_ORDER = [1, 2, 3, 5, 6, 7];               // belts in display order
  const MIN_SEPARATION_MS = 1 * MINUTE_MS;              // lane break if overlap within <1 min
  const DEFAULT_PX_PER_MIN = 8;                         // default zoom

  // get CSS vars
  const cssNum = (name, fallback) => {
    const v = parseInt(
      getComputedStyle(document.documentElement).getPropertyValue(name),
      10
    );
    return Number.isFinite(v) ? v : fallback;
  };

  const LANE_H = cssNum('--lane-height', 58);
  const LANE_GAP = cssNum('--lane-gap', 10);
  const BELT_PAD = cssNum('--belt-pad-y', 18);

  // ------- DOM refs -------
  const beltChips = $('#beltChips');
  const zoomSel = $('#zoom');
  const nowBtn = $('#nowBtn');
  const meta = $('#meta');

  const scrollOuter = $('#scrollOuter');
  const scrollInner = $('#scrollInner');
  const rowsHost = $('#rows');
  const canvasRuler = /** @type {HTMLCanvasElement} */ ($('#ruler'));
  const nowLineEl = $('#nowLine');

  // ------- state -------
  let assignments = null;
  let flightsRaw = []; // full list from assignments.json
  let flightsView = []; // filtered list (belt filter)
  let pxPerMin = parseFloat(zoomSel?.value || DEFAULT_PX_PER_MIN);
  let beltFilter = new Set(); // if empty => show all

  let timeMin = null; // Date
  let timeMax = null; // Date

  // local rolling history
  const LS_KEY = 'beltTimelineHistoryV1';

  // ------- utilities -------
  function pad2(n) {
    return String(n).padStart(2, '0');
  }
  function hhmm(dLike) {
    if (!dLike) return '';
    const d = new Date(dLike);
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  }

  function classifyDelay(delayMin) {
    if (delayMin == null) return 'ok';
    if (delayMin >= 20) return 'late';
    if (delayMin >= 10) return 'mid';
    if (delayMin <= -1) return 'early';
    return 'ok';
  }

  // Completed/grey check
  function isCompleted(f, nowMs) {
    const endMs = +new Date(f.end);
    return nowMs > endMs + COMPLETED_GRACE_MS;
  }

  // ------- local history merge -------
  function loadLocalHistory() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed;
    } catch {
      return [];
    }
  }

  function saveLocalHistory(list) {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(list));
    } catch {
      /* ignore */
    }
  }

  // merge + prune >4h old
  function mergeHistory(newRows) {
    const now = Date.now();
    const cutoff = now - HISTORY_WINDOW_MS;

    const prev = loadLocalHistory().filter(r => {
      const endMs = +new Date(r.end || r.eta || 0);
      return endMs >= cutoff;
    });

    // index by flight+start to avoid dup spam
    const keyOf = r => `${r.flight||''}|${r.start||''}|${r.end||''}`;

    const seen = new Set(prev.map(keyOf));
    for (const r of newRows) {
      const k = keyOf(r);
      if (!seen.has(k)) {
        prev.push(r);
        seen.add(k);
      }
    }
    saveLocalHistory(prev);
    return prev;
  }

  // combine server rows + local history, then filter to [now-4h, now+some pad]
  function buildFlightList() {
    const now = Date.now();
    const hist = mergeHistory(assignments.rows || []);
    const cutoffLow = now - HISTORY_WINDOW_MS;

    const merged = hist.filter(r => {
      const endMs = +new Date(r.end || r.eta || 0);
      return endMs >= cutoffLow;
    });

    // De-dupe same flight time range, keep latest info
    const map = new Map();
    for (const r of merged) {
      const k = `${r.flight||''}|${r.start||''}|${r.end||''}`;
      map.set(k, r);
    }
    return [...map.values()];
  }

  // ------- belt chips -------
  function buildBeltChips() {
    if (!beltChips) return;
    beltChips.innerHTML = '';
    const frag = document.createDocumentFragment();

    function mk(label, key) {
      const b = el('button', 'chip');
      b.textContent = label;
      b.dataset.key = key;
      b.addEventListener('click', () => toggleFilter(key));
      frag.appendChild(b);
    }

    BELTS_ORDER.forEach(n => mk(`Belt ${n}`, String(n)));
    mk('All', 'all');
    mk('None', 'none');

    beltChips.appendChild(frag);
    syncChipHighlights();
  }

  function toggleFilter(key) {
    if (key === 'all') {
      beltFilter.clear();
    } else if (key === 'none') {
      beltFilter = new Set(['__none__']);
    } else {
      const n = parseInt(key, 10);
      if (Number.isFinite(n)) {
        if (beltFilter.has(n)) beltFilter.delete(n);
        else beltFilter.add(n);
      }
    }
    syncChipHighlights();
    redraw();
  }

  function syncChipHighlights() {
    const chips = beltChips.querySelectorAll('.chip');
    chips.forEach(c => {
      const k = c.dataset.key;
      let on = false;
      if (k === 'all' && beltFilter.size === 0) on = true;
      else if (k === 'none' && beltFilter.has('__none__')) on = true;
      else if (/^\d+$/.test(k) && beltFilter.has(parseInt(k, 10))) on = true;
      c.classList.toggle('on', on);
    });
  }

  // ------- timeline math -------
  function computeTimeWindow() {
    const now = Date.now();
    const rows = flightsRaw;
    if (rows.length) {
      const starts = rows.map(r => +new Date(r.start || r.eta));
      const ends = rows.map(r => +new Date(r.end || r.eta));
      const pad = 45 * MINUTE_MS;
      const minT = Math.min(...starts, now - HISTORY_WINDOW_MS) - pad;
      const maxT = Math.max(...ends, now) + pad;
      timeMin = new Date(minT);
      timeMax = new Date(maxT);
    } else {
      // fallback empty
      timeMin = new Date(now - 90 * MINUTE_MS);
      timeMax = new Date(now + 90 * MINUTE_MS);
    }
  }

  function xForDate(dLike) {
    const ms = (+new Date(dLike)) - (+timeMin);
    return (ms / MINUTE_MS) * pxPerMin;
  }

  // Pack overlapping flights within 1 minute separation into separate vertical lanes
  function packLanes(items) {
    const sorted = items.slice().sort((a, b) => +new Date(a.start) - +new Date(b.start));
    const laneEnd = []; // ms per lane
    for (const f of sorted) {
      const s = +new Date(f.start);
      const e = +new Date(f.end);
      let laneIndex = -1;
      for (let i = 0; i < laneEnd.length; i++) {
        if (s >= laneEnd[i] + MIN_SEPARATION_MS) {
          laneIndex = i;
          break;
        }
      }
      if (laneIndex === -1) {
        laneEnd.push(e);
        f._lane = laneEnd.length - 1;
      } else {
        laneEnd[laneIndex] = e;
        f._lane = laneIndex;
      }
    }
    return { lanes: Math.max(1, laneEnd.length), packed: sorted };
  }

  // ------- draw ruler (hour ticks) -------
  function drawRuler() {
    if (!canvasRuler) return;
    const ctx = canvasRuler.getContext('2d');
    const width = Math.max(xForDate(timeMax) + 200, scrollOuter.clientWidth);
    const height = 44;

    const dpr = window.devicePixelRatio || 1;
    canvasRuler.width = Math.floor(width * dpr);
    canvasRuler.height = Math.floor(height * dpr);
    canvasRuler.style.width = `${width}px`;
    canvasRuler.style.height = `${height}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    ctx.clearRect(0, 0, width, height);

    // panel background
    ctx.fillStyle = getComputedStyle(document.documentElement)
      .getPropertyValue('--panel') || '#111b26';
    ctx.fillRect(0, 0, width, height);

    // bottom border
    ctx.strokeStyle = '#1a2a3a';
    ctx.beginPath();
    ctx.moveTo(0, height - 1);
    ctx.lineTo(width, height - 1);
    ctx.stroke();

    // draw hour ticks + faint 10min ticks
    const start = new Date(timeMin);
    start.setMinutes(0, 0, 0);
    const endMs = +timeMax;

    for (let t = +start; t <= endMs; t += 10 * MINUTE_MS) {
      const isHour = (new Date(t).getMinutes() === 0);
      const x = Math.floor(xForDate(t));

      // tick line
      ctx.fillStyle = isHour ? 'rgba(255,255,255,0.12)' : 'rgba(255,255,255,0.04)';
      ctx.fillRect(x, 0, 1, height);

      // hour label
      if (isHour) {
        ctx.fillStyle = '#dce6f2';
        ctx.font = '14px ui-sans-serif, system-ui, Segoe UI, Roboto, Arial';
        ctx.textBaseline = 'top';
        ctx.fillText(hhmm(t), x + 6, 6);
      }
    }
  }

  // ------- draw rows / grid / pucks -------
  function buildPuck(f, nowMs) {
    // decide class
    let baseClass = classifyDelay(f.delay_min); // ok/mid/late/early
    if (isCompleted(f, nowMs)) {
      baseClass = 'stale'; // completed grey
    }

    const p = el('div', `puck ${baseClass}`);

    // label (flight • DEST)
    const title = el('div', 'title');
    title.textContent = `${(f.flight || '').trim()} • ${(f.origin_iata || '').trim() || f.origin || ''}`.replace(/\s+/g, ' ');

    // times ( belt start → belt end )
    const sub = el('div', 'sub');
    sub.textContent = `${hhmm(f.start)} → ${hhmm(f.end)}`;

    p.appendChild(title);
    p.appendChild(sub);

    // tooltip with extra info
    const tipLines = [
      `${(f.flight || '').trim()} ${f.origin ? `• ${f.origin}` : ''}`.trim(),
      `${hhmm(f.start)} → ${hhmm(f.end)}`,
      f.airline || '',
      f.aircraft || '',
      f.flow || '',
      f.reason ? `Reason: ${f.reason}` : ''
    ].filter(Boolean);
    p.setAttribute('data-tip', tipLines.join('\n'));

    // horiz positioning
    const left = xForDate(f.start);
    const right = xForDate(f.end);
    p.style.left = `${left}px`;
    p.style.width = `${Math.max(120, right - left - 4)}px`;

    // vertical lane offset (top-aligned adjustment is via translateY tweak)
    p.style.top = `${f._lane * (LANE_H + LANE_GAP)}px`;
    p.style.transform = 'translateY(-10%)';

    return p;
  }

  function drawRows() {
    rowsHost.innerHTML = '';
    const frag = document.createDocumentFragment();

    const nowMs = Date.now();
    const beltsToShow = BELTS_ORDER; // always show 1..7

    let totalHeight = 0;

    for (const beltNum of beltsToShow) {
      // belt row wrapper
      const row = el('div', 'belt-row');
      const name = el('div', 'belt-name');
      name.textContent = `Belt ${beltNum}`;
      const inner = el('div', 'row-inner');

      row.appendChild(name);
      row.appendChild(inner);

      // flights in this belt (filtered after we apply beltFilter)
      const group = flightsView.filter(r => r.belt === beltNum);

      // pack lanes
      const { lanes, packed } = packLanes(group);

      // row height
      const contentH = lanes * (LANE_H + LANE_GAP) - LANE_GAP;
      row.style.minHeight = `calc(${BELT_PAD}px * 2 + ${contentH}px)`;

      // add pucks
      for (const f of packed) {
        inner.appendChild(buildPuck(f, nowMs));
      }

      frag.appendChild(row);

      // measure after in-DOM append?
      // we'll just approximate:
      totalHeight += (BELT_PAD * 2 + contentH);
    }

    rowsHost.appendChild(frag);

    // update scrollInner width
    const w = Math.max(xForDate(timeMax) + 200, scrollOuter.clientWidth);
    scrollInner.style.width = `${w}px`;

    // draw gridlines after rows
    drawGridlines(totalHeight);

    // update now line height/pos
    updateNowLine(totalHeight);
  }

  function drawGridlines(totalHeight) {
    // clear prior
    [...scrollInner.querySelectorAll('.gridline')].forEach(n => n.remove());

    const frag = document.createDocumentFragment();
    const start = new Date(timeMin);
    start.setMinutes(0, 0, 0);
    const endMs = +timeMax;

    for (let t = +start; t <= endMs; t += 10 * MINUTE_MS) {
      const isHour = (new Date(t).getMinutes() === 0);
      const x = xForDate(t);

      const g = el('div', 'gridline');
      g.style.left = `${x}px`;
      g.style.height = `${totalHeight}px`;
      g.classList.toggle('hour', isHour);
      frag.appendChild(g);
    }

    scrollInner.appendChild(frag);
  }

  function updateNowLine(totalHeight) {
    if (!nowLineEl) return;
    nowLineEl.style.left = `${xForDate(Date.now())}px`;
    nowLineEl.style.height = `${totalHeight}px`;
  }

  // ------- main redraw -------
  function redraw() {
    // filter by belt chips
    if (beltFilter.size === 0) {
      flightsView = flightsRaw.slice();
    } else if (beltFilter.has('__none__')) {
      flightsView = []; // show nothing
    } else {
      flightsView = flightsRaw.filter(r => beltFilter.has(r.belt));
    }

    computeTimeWindow();
    drawRuler();
    drawRows();
  }

  // ------- interactions -------
  zoomSel?.addEventListener('change', () => {
    pxPerMin = parseFloat(zoomSel.value || DEFAULT_PX_PER_MIN);
    redraw();
  });

  nowBtn?.addEventListener('click', () => {
    const nowX = xForDate(Date.now());
    const vw = scrollOuter.clientWidth;
    scrollOuter.scrollLeft = Math.max(0, nowX - vw / 2);
  });

  window.addEventListener('resize', redraw);

  // keep now line drifting without full redraw
  setInterval(() => {
    const totalH = rowsHost.getBoundingClientRect().height || 0;
    updateNowLine(totalH);
  }, 30 * 1000);

  // horizontal scroll sync: (canvas is full width, so nothing special to translate here)

  // ------- auto-refresh every ~90s -------
  setInterval(() => {
    fetch('assignments.json', { cache: 'no-store' })
      .then(r => r.json())
      .then(data => {
        if (!data) return;
        const prevStamp = assignments?.generated_at_utc;
        assignments = data;

        // merge with local rolling history
        const merged = buildFlightList();
        flightsRaw = merged;

        if (meta) {
          meta.textContent = `Generated ${assignments.generated_at_local} • Horizon ${assignments.horizon_minutes} min`;
        }

        if (data.generated_at_utc !== prevStamp) {
          // time window might shift
          redraw();
        } else {
          redraw();
        }
      })
      .catch(() => { /* ignore */ });
  }, 90 * 1000);

  // ------- initial load -------
  function initialLoad() {
    return fetch('assignments.json', { cache: 'no-store' })
      .then(r => r.json())
      .then(data => {
        assignments = data;
        if (meta) {
          meta.textContent = `Generated ${assignments.generated_at_local} • Horizon ${assignments.horizon_minutes} min`;
        }

        // build local merged flight list
        const merged = buildFlightList();
        flightsRaw = merged;

        buildBeltChips();
        redraw();

        // scroll "now" to center on first paint
        const nowX = xForDate(Date.now());
        const vw = scrollOuter.clientWidth;
        scrollOuter.scrollLeft = Math.max(0, nowX - vw / 2);
      });
  }

  initialLoad();
})();
