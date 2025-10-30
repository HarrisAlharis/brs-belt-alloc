/* docs/timeline.js
 * BRS — Baggage Belt Timeline (Staff Operations Version)
 * Enhanced for clarity and usability
 */

(function () {
  // ------- helpers -------
  const $ = (s) => document.querySelector(s);
  const el = (tag, cls) => { 
    const n = document.createElement(tag); 
    if (cls) n.className = cls; 
    return n; 
  };
  const minute = 60 * 1000;
  const dFmt = (d) => {
    const dt = new Date(d);
    return `${String(dt.getHours()).padStart(2,'0')}:${String(dt.getMinutes()).padStart(2,'0')}`;
  };

  // ------- DOM -------
  const beltChips   = $('#beltChips');
  const zoomSel     = $('#zoom');
  const nowBtn      = $('#nowBtn');
  const meta        = $('#meta');
  const scrollOuter = $('#scrollOuter');
  const scrollInner = $('#scrollInner');
  const rowsHost    = $('#rows');
  const canvasRuler = $('#ruler');
  const nowLine     = $('#nowLine');

  // ------- state -------
  const BELTS_ORDER = [1, 2, 3, 5, 6, 7];
  let assignments = null;
  let flightsRaw = [];
  let flights = [];
  let pxPerMin = parseFloat(zoomSel?.value || '8');
  let timeMin = null, timeMax = null;
  let beltFilter = new Set();

  const DEDUPE_START_WINDOW_MS = 5 * minute;
  const HISTORY_WINDOW_MIN = 240;
  const COMPLETED_GRACE_MS = 2 * minute;

  const getCssNum = (name, fallback) => {
    const v = parseInt(getComputedStyle(document.documentElement).getPropertyValue(name), 10);
    return Number.isFinite(v) ? v : fallback;
  };
  const LANE_H   = getCssNum('--lane-height', 68);
  const LANE_GAP = getCssNum('--lane-gap', 8);
  const BELT_PAD = getCssNum('--belt-pad-y', 20);

  const fetchJSON = (u) => fetch(u, { cache: 'no-store' }).then(r => r.json());

  // ------- normalise row -------
  function normaliseRow(r) {
    const out = { ...r };

    // belt → number
    if (out.belt !== undefined && out.belt !== null && out.belt !== '') {
      const nb = Number(out.belt);
      out.belt = Number.isFinite(nb) ? nb : out.belt;
    }

    // start/end defaults
    if (!out.start && out.eta) out.start = out.eta;
    if (!out.end && out.start) {
      const s = new Date(out.start);
      out.end = new Date(s.getTime() + 30 * minute).toISOString();
    }

    return out;
  }

  // ------- de-dupe -------
  function dedupeFlights(rows) {
    const keep = [];
    const seenMap = new Map();

    for (const r0 of rows) {
      const r = normaliseRow(r0);
      const belt = r.belt;

      if (belt == null || belt === '') {
        keep.push(r);
        continue;
      }

      const flightText = (r.flight || '').trim().toLowerCase();
      const startMs = +new Date(r.start);
      const key = `${belt}|${flightText}`;

      if (!seenMap.has(key)) {
        seenMap.set(key, [{ startMs }]);
        keep.push(r);
        continue;
      }

      const arr = seenMap.get(key);
      let isDup = false;
      for (const rec of arr) {
        if (Math.abs(startMs - rec.startMs) <= DEDUPE_START_WINDOW_MS) {
          isDup = true;
          break;
        }
      }
      if (!isDup) {
        arr.push({ startMs });
        keep.push(r);
      }
    }

    return keep;
  }

  // ------- delay classification -------
  function classByDelay(d) {
    if (d == null) return 'ok';
    if (d >= 20) return 'late';
    if (d >= 10) return 'mid';
    if (d <= -1) return 'early';
    return 'ok';
  }

  function isCompletedPast(f, nowMs) {
    const endMs = +new Date(f.end);
    return nowMs > endMs + COMPLETED_GRACE_MS;
  }

  const xForDate = (d) => ((+new Date(d)) - (+timeMin)) / 60000 * pxPerMin;

  // ------- build puck -------
  function buildPuck(f) {
    const nowMs = Date.now();
    const completed = isCompletedPast(f, nowMs);
    let cls = classByDelay(f.delay_min);
    if (completed) cls = 'stale';

    const p = el('div', `puck ${cls}`);

    const title = el('div', 'title');
    title.textContent = `${(f.flight || '').trim()} • ${(f.origin_iata || '').trim()}`;
    
    const sub = el('div', 'sub');
    const airline = f.airline || '';
    const pax = f.pax_estimate ? ` • ${f.pax_estimate}pax` : '';
    sub.textContent = `${airline}${pax}`;

    // Enhanced tooltip with more operational info
    const tipLines = [
      `Flight: ${(f.flight || '').trim()}`,
      `Origin: ${f.origin || f.origin_iata || 'Unknown'}`,
      `Airline: ${f.airline || 'Unknown'}`,
      `Aircraft: ${f.aircraft || 'Unknown'}`,
      `Passengers: ${f.pax_estimate || 'Unknown'}`,
      `Belt Window: ${dFmt(f.start)} - ${dFmt(f.end)}`,
      `Status: ${f.status || 'Unknown'}`,
      `Delay: ${f.delay_min !== null ? f.delay_min + ' min' : 'Unknown'}`,
      `Flow: ${f.flow || 'Unknown'}`,
      f.reason ? `Assignment: ${f.reason}` : ''
    ].filter(Boolean);
    p.setAttribute('data-tip', tipLines.join('\n'));

    p.appendChild(title);
    p.appendChild(sub);

    const left = xForDate(f.start);
    const right = xForDate(f.end);
    p.style.left = `${left}px`;
    p.style.width = `${Math.max(140, right - left)}px`;
    p.style.top = `${f._lane * (LANE_H + LANE_GAP)}px`;

    return p;
  }

  // ------- pack lanes -------
  function packLanes(items) {
    const sorted = items.slice().sort((a, b) => +new Date(a.start) - +new Date(b.start));
    const lanesLastEnd = [];
    const MIN_SEPARATION_MS = 1 * minute;

    for (const f of sorted) {
      const s = +new Date(f.start), e = +new Date(f.end);
      let lane = -1;
      for (let i = 0; i < lanesLastEnd.length; i++) {
        if (s >= (lanesLastEnd[i] + MIN_SEPARATION_MS)) {
          lane = i;
          break;
        }
      }
      if (lane === -1) {
        lane = lanesLastEnd.length;
        lanesLastEnd.push(e);
      } else {
        lanesLastEnd[lane] = e;
      }
      f._lane = lane;
    }

    return { lanes: Math.max(1, lanesLastEnd.length), items: sorted };
  }

  // ------- ruler -------
  function drawRuler() {
    if (!canvasRuler) return;
    const ctx = canvasRuler.getContext('2d');
    const width = Math.max(xForDate(timeMax) + 200, scrollOuter.clientWidth);
    const height = 50;
    const dpr = window.devicePixelRatio || 1;

    canvasRuler.width = Math.floor(width * dpr);
    canvasRuler.height = Math.floor(height * dpr);
    canvasRuler.style.width = `${width}px`;
    canvasRuler.style.height = `${height}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--panel') || '#1e293b';
    ctx.fillRect(0, 0, width, height);

    // Draw subtle gradient for depth
    const gradient = ctx.createLinearGradient(0, 0, 0, height);
    gradient.addColorStop(0, 'rgba(255,255,255,0.05)');
    gradient.addColorStop(1, 'rgba(255,255,255,0.02)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, height);

    ctx.strokeStyle = '#334155';
    ctx.beginPath();
    ctx.moveTo(0, height - 1);
    ctx.lineTo(width, height - 1);
    ctx.stroke();

    ctx.fillStyle = '#f1f5f9';
    ctx.font = '600 15px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.textBaseline = 'alphabetic';

    const startAligned = new Date(timeMin);
    startAligned.setMinutes(0, 0, 0);
    const endMs = +timeMax;

    for (let t = +startAligned; t <= endMs; t += 10 * minute) {
      const x = Math.floor(xForDate(t));
      const dt = new Date(t);
      const mm = dt.getMinutes();
      const isHour = (mm === 0);

      ctx.fillStyle = isHour ? '#475569' : 'rgba(71, 85, 105, 0.4)';
      ctx.fillRect(x, 0, 1, height);

      if (isHour) {
        ctx.fillStyle = '#f1f5f9';
        ctx.fillText(dFmt(t), x + 10, height - 15);
      }
    }
  }

  // ------- gridlines -------
  function addGridlines(totalHeight) {
    [...scrollInner.querySelectorAll('.gridline')].forEach(x => x.remove());
    const frag = document.createDocumentFragment();

    const startAligned = new Date(timeMin);
    startAligned.setMinutes(0, 0, 0);
    const endMs = +timeMax;

    for (let t = +startAligned; t <= endMs; t += 10 * minute) {
      const x = xForDate(t);
      const dt = new Date(t);
      const mm = dt.getMinutes();
      const isHour = (mm === 0);

      const g = el('div', 'gridline');
      g.style.left = `${x}px`;
      g.style.height = `${totalHeight}px`;
      if (isHour) g.classList.add('hour');
      frag.appendChild(g);
    }

    scrollInner.appendChild(frag);
  }

  // ------- now line -------
  function updateNowLine(totalHeight) {
    if (!nowLine) return;
    nowLine.style.left = `${xForDate(Date.now())}px`;
    nowLine.style.height = `${totalHeight}px`;
  }

  // ------- draw rows -------
  function drawRows() {
    rowsHost.innerHTML = '';
    const frag = document.createDocumentFragment();

    let totalHeight = 0;
    const beltsToShow =
      beltFilter.size === 0 || beltFilter.has('__none__')
        ? (beltFilter.has('__none__') ? [] : BELTS_ORDER)
        : BELTS_ORDER.filter(b => beltFilter.has(b));

    for (const b of beltsToShow) {
      const beltRow = el('div', 'belt-row');
      const beltName = el('div', 'belt-name');
      beltName.textContent = `Belt ${b}`;
      const inner = el('div', 'row-inner');

      beltRow.appendChild(beltName);
      beltRow.appendChild(inner);

      const items = flights.filter(r => r.belt === b);

      const { lanes, items: packed } = packLanes(items);
      const contentH = lanes * (LANE_H + LANE_GAP) - LANE_GAP;
      beltRow.style.minHeight = `calc(${BELT_PAD}px * 2 + ${contentH}px)`;

      for (const f of packed) {
        inner.appendChild(buildPuck(f));
      }

      frag.appendChild(beltRow);
      totalHeight += beltRow.getBoundingClientRect().height;
    }

    rowsHost.appendChild(frag);

    const width = Math.max(xForDate(timeMax) + 200, scrollOuter.clientWidth);
    scrollInner.style.width = `${width}px`;

    addGridlines(totalHeight);
    updateNowLine(totalHeight);
  }

  function drawAll() {
    drawRuler();
    drawRows();
  }

  // ------- compute time window -------
  function computeTimeWindow(allRows) {
    const nowMs = Date.now();
    const historyCutoff = nowMs - HISTORY_WINDOW_MIN * minute;

    const visibleRows = allRows.filter(r => {
      const endMs = +new Date(r.end);
      return endMs >= historyCutoff;
    });

    if (visibleRows.length > 0) {
      const starts = visibleRows.map(r => +new Date(r.start || r.eta));
      const ends = visibleRows.map(r => +new Date(r.end || r.eta));
      const padMin = 45 * minute;
      return {
        flightsFiltered: visibleRows,
        tMin: new Date(Math.min(...starts) - padMin),
        tMax: new Date(Math.max(...ends) + padMin),
      };
    }

    // Fallback for old data
    if (allRows.length > 0) {
      const starts = allRows.map(r => +new Date(r.start || r.eta));
      const ends = allRows.map(r => +new Date(r.end || r.eta));
      const padMin = 45 * minute;
      return {
        flightsFiltered: allRows,
        tMin: new Date(Math.min(...starts) - padMin),
        tMax: new Date(Math.max(...ends) + padMin),
      };
    }

    const now = new Date();
    return {
      flightsFiltered: [],
      tMin: new Date(+now - 90 * minute),
      tMax: new Date(+now + 90 * minute),
    };
  }

  // ------- belt chips -------
  function buildBeltChips() {
    if (!beltChips) return;
    beltChips.innerHTML = '';
    const frag = document.createDocumentFragment();

    const mkChip = (label, key) => {
      const b = el('button', 'chip');
      b.textContent = label;
      b.dataset.key = key;
      b.addEventListener('click', () => toggleFilter(key));
      frag.appendChild(b);
    };

    // Add "All" first for better UX
    mkChip('All Belts', 'all');
    BELTS_ORDER.forEach(n => mkChip(`Belt ${n}`, String(n)));
    mkChip('Hide All', 'none');

    beltChips.appendChild(frag);

    // Set "All" as default active
    [...beltChips.querySelectorAll('.chip')].forEach(c =>
      c.classList.toggle('on', c.dataset.key === 'all')
    );
  }

  function toggleFilter(key) {
    if (key === 'all') {
      beltFilter.clear();
    } else if (key === 'none') {
      beltFilter = new Set(['__none__']);
    } else {
      const n = Number(key);
      if (Number.isFinite(n)) {
        if (beltFilter.has(n)) beltFilter.delete(n);
        else beltFilter.add(n);
      }
    }

    [...beltChips.querySelectorAll('.chip')].forEach(c => {
      const k = c.dataset.key;
      const on =
        (k === 'all' && beltFilter.size === 0) ||
        (k === 'none' && beltFilter.has('__none__')) ||
        (/^\d+$/.test(k) && beltFilter.has(Number(k)));
      c.classList.toggle('on', on);
    });

    drawAll();
  }

  // ------- load -------
  function load() {
    return fetchJSON('assignments.json').then(data => {
      assignments = data;

      const normed = (data.rows || []).map(normaliseRow);
      const deduped = dedupeFlights(normed);
      const { flightsFiltered, tMin, tMax } = computeTimeWindow(deduped);

      flights = flightsFiltered;
      flightsRaw = normed;
      timeMin = tMin;
      timeMax = TMax;

      if (meta) {
        const localTime = assignments.generated_at_local || assignments.generated_at_utc;
        meta.textContent = `Updated: ${localTime} • Horizon: ${assignments.horizon_minutes}min`;
      }

      buildBeltChips();
      drawAll();
    }).catch(err => {
      console.error('Failed to load assignments:', err);
      meta.textContent = 'Unable to load flight data';
    });
  }

  // ------- interactions -------
  zoomSel?.addEventListener('change', () => {
    pxPerMin = parseFloat(zoomSel.value || '8');
    drawAll();
  });

  nowBtn?.addEventListener('click', () => {
    const nowX = xForDate(Date.now());
    const viewW = scrollOuter.clientWidth;
    scrollOuter.scrollLeft = Math.max(0, nowX - viewW / 2);
  });

  window.addEventListener('resize', drawAll);

  // Update now line position regularly
  setInterval(() => {
    updateNowLine(rowsHost.getBoundingClientRect().height || 0);
  }, 30 * 1000);

  // Auto-refresh data
  setInterval(() => {
    fetch('assignments.json', { cache: 'no-store' })
      .then(r => {
        if (!r.ok) throw new Error('Network error');
        return r.json();
      })
      .then(data => {
        if (!data) return;
        assignments = data;

        const normed = (data.rows || []).map(normaliseRow);
        const deduped = dedupeFlights(normed);
        const { flightsFiltered, tMin, tMax } = computeTimeWindow(deduped);

        flights = flightsFiltered;
        flightsRaw = normed;
        timeMin = tMin;
        timeMax = tMax;

        if (meta) {
          const localTime = assignments.generated_at_local || assignments.generated_at_utc;
          meta.textContent = `Updated: ${localTime} • Horizon: ${assignments.horizon_minutes}min`;
        }

        drawAll();
      })
      .catch(err => {
        console.warn('Refresh failed:', err);
      });
  }, 90 * 1000);

  // Initialize
  load().then(() => {
    // Scroll to show current time
    setTimeout(() => {
      const nowX = xForDate(Date.now());
      const viewW = scrollOuter.clientWidth;
      scrollOuter.scrollLeft = Math.max(0, nowX - viewW / 3);
    }, 100);
  });

})();