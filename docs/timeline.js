/* docs/timeline.js
 * Current production timeline script.
 * CHANGE IN THIS VERSION:
 * - Added de-duplication so we don't render the same flight twice on the same belt
 *   at effectively the same window.
 *
 *   We consider two rows "the same flight block" if:
 *     - same flight text (case-insensitive, trimmed)
 *     - same belt number
 *     - start times within 5 minutes of each other
 *
 *   Only the first seen block is kept.
 *
 * All other behaviour (packing, colours, zoom, history greying, etc.) is untouched.
 */

(function () {
  // ------- helpers -------
  const $ = (s) => document.querySelector(s);
  const el = (tag, cls) => { const n = document.createElement(tag); if (cls) n.className = cls; return n; };
  const minute = 60 * 1000;
  const dFmt = (d) => { const dt = new Date(d); return `${String(dt.getHours()).padStart(2,'0')}:${String(dt.getMinutes()).padStart(2,'0')}`; };

  // ------- DOM (matches timeline.html) -------
  const beltChips   = $('#beltChips');
  const zoomSel     = $('#zoom');
  const nowBtn      = $('#nowBtn');
  const meta        = $('#meta');

  const viewport    = $('#viewport');
  const scrollOuter = $('#scrollOuter');
  const scrollInner = $('#scrollInner');
  const rowsHost    = $('#rows');
  const canvasRuler = /** @type {HTMLCanvasElement} */($('#ruler'));
  const nowLine     = $('#nowLine');

  // ------- state -------
  const BELTS_ORDER = [1,2,3,5,6,7];
  let assignments = null;
  let flightsRaw = [];    // raw from assignments.json
  let flights = [];       // deduped view we'll actually render
  let pxPerMin = parseFloat(zoomSel?.value || '8'); // default zoom 8 px/min
  let timeMin = null, timeMax = null;
  let beltFilter = new Set(); // empty => show all

  // how long we consider "this is really the same block" when deduping
  const DEDUPE_START_WINDOW_MS = 5 * minute;

  // historic window rules for greying completed flights
  // - we keep up to 4h (240 min) of history;
  // - a flight whose (end + 2 min) is < "now" is considered completed/past,
  //   and drawn grey.
  const HISTORY_WINDOW_MIN = 240;
  const COMPLETED_GRACE_MS = 2 * minute;

  // vertical packing style vars (pulled from CSS custom props so visuals match)
  const getCssNum = (name, fallback) => {
    const v = parseInt(getComputedStyle(document.documentElement).getPropertyValue(name), 10);
    return Number.isFinite(v) ? v : fallback;
  };
  const LANE_H   = getCssNum('--lane-height', 58);
  const LANE_GAP = getCssNum('--lane-gap', 10);
  const BELT_PAD = getCssNum('--belt-pad-y', 18);

  // ------- fetch helpers -------
  const fetchJSON = (u) => fetch(u, { cache: 'no-store' }).then(r => r.json());

  // ------- NEW: de-dupe logic -------
  // We will collapse "duplicate" blocks that refer to the same belt/flight
  // and essentially the same start. We keep the first instance.
  function dedupeFlights(rows) {
    const keep = [];
    // map key -> array of {startMs, idxKept}
    // key is "<belt>|<flightTextLower>"
    const seenMap = new Map();

    for (const r of rows) {
      // belt can be number or "", we only de-dupe when belt is a real belt
      const belt = r.belt;
      if (!belt && belt !== 0) {
        // if belt missing, just keep it (no dedupe in that case)
        keep.push(r);
        continue;
      }

      const flightText = (r.flight || '').trim().toLowerCase();
      const startMs = +new Date(r.start);

      const mapKey = `${belt}|${flightText}`;
      if (!seenMap.has(mapKey)) {
        // first time we see this belt+flight
        seenMap.set(mapKey, [{ startMs }]);
        keep.push(r);
        continue;
      }

      // check if this start is "close enough" to an already-kept start
      const startsForKey = seenMap.get(mapKey);
      let isDup = false;
      for (const rec of startsForKey) {
        if (Math.abs(startMs - rec.startMs) <= DEDUPE_START_WINDOW_MS) {
          // treat as duplicate -> skip
          isDup = true;
          break;
        }
      }

      if (!isDup) {
        // new distinct time block -> keep it
        startsForKey.push({ startMs });
        keep.push(r);
      }
    }

    return keep;
  }

  // ------- classify delay to assign colour class -------
  // (unchanged logic)
  function classByDelay(d) {
    if (d == null) return 'ok';
    if (d >= 20) return 'late';
    if (d >= 10) return 'mid';
    if (d <= -1)  return 'early';
    return 'ok';
  }

  // ------- detect "completed/past" for greying -------
  function isCompletedPast(flightObj, nowMs) {
    const endMs = +new Date(flightObj.end);
    // completed if ended >2 min ago
    if (nowMs > endMs + COMPLETED_GRACE_MS) return true;
    return false;
  }

  // ------- build puck DOM -------
  function buildPuck(f) {
    const nowMs = Date.now();
    const completed = isCompletedPast(f, nowMs);

    // base colour from delay
    let cls = classByDelay(f.delay_min);

    // override with grey if completed/past
    if (completed) {
      cls = 'done'; // .puck.done defined in CSS for grey style
    }

    const p = el('div', `puck ${cls}`);

    // Title row: flight number • origin_iata
    // We keep full flight number visible per your requirement.
    const title = el('div','title');
    title.textContent = `${(f.flight||'').trim()} • ${(f.origin_iata||'').trim() || f.origin || ''}`.replace(/\s+/g,' ');

    // Sub row: scheduled → ETA   (unchanged)
    // NOTE: we still show the belt window times inside the puck
    // because that's what timeline currently uses; we are not
    // changing that here.
    const sub    = el('div','sub');
    sub.textContent = `${dFmt(f.start)} → ${dFmt(f.end)}`;

    // tooltip full details (unchanged)
    const tipLines = [
      `${(f.flight||'').trim()} ${f.origin ? `• ${f.origin}` : ''}`,
      `${dFmt(f.start)} → ${dFmt(f.end)}`,
      f.flow,
      f.airline,
      f.aircraft,
      f.reason ? `Reason: ${f.reason}` : ''
    ].filter(Boolean);
    p.setAttribute('data-tip', tipLines.join('\n'));

    p.appendChild(title);
    p.appendChild(sub);

    // horizontal placement
    const left = xForDate(f.start);
    const right = xForDate(f.end);
    p.style.left  = `${left}px`;
    p.style.width = `${Math.max(120, right - left - 4)}px`;

    // vertical lane placement
    p.style.top   = `${f._lane * (LANE_H + LANE_GAP)}px`;

    return p;
  }

  // ------- x position helper -------
  const xForDate = (d) => ((+new Date(d)) - (+timeMin)) / 60000 * pxPerMin;

  // ------- lane pack for one belt (unchanged logic) -------
  // but note: we call this AFTER de-dupe
  function packLanes(items) {
    const sorted = items.slice().sort((a,b)=>+new Date(a.start) - +new Date(b.start));
    const lanesLastEnd = []; // track lane availability in ms
    const MIN_SEPARATION_MS = 1 * minute; // KEEP: allow stacking if they overlap,
                                          // but if they intersect in time, new lane.

    for (const f of sorted) {
      const s = +new Date(f.start), e = +new Date(f.end);
      let lane = -1;
      for (let i=0; i<lanesLastEnd.length; i++) {
        if (s >= (lanesLastEnd[i] + MIN_SEPARATION_MS)) {
          lane = i; break;
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

  // ------- ruler drawing (unchanged except it uses pxPerMin default 8) -------
  function drawRuler() {
    if (!canvasRuler) return;
    const ctx = canvasRuler.getContext('2d');
    const width = Math.max(xForDate(timeMax) + 200, scrollOuter.clientWidth);
    const height = 44;

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

    // draw hour and faint 10-min ticks
    const startAligned = new Date(timeMin);
    startAligned.setMinutes(0,0,0);
    const endMs = +timeMax;

    for (let t = +startAligned; t <= endMs; t += 10*minute) {
      const x = Math.floor(xForDate(t));
      const dt = new Date(t);
      const mm = dt.getMinutes();
      const isHour = (mm === 0);

      // vertical tick in ruler bg
      ctx.fillStyle = isHour ? '#213043' : 'rgba(33,48,67,0.4)';
      ctx.fillRect(x, 0, 1, height);

      if (isHour) {
        ctx.fillStyle = '#dce6f2';
        ctx.fillText(dFmt(t), x + 8, height - 12);
      }
    }
  }

  // ------- add vertical gridlines behind rows (hour + faint 10-min) -------
  function addGridlines(totalHeight) {
    // remove previous
    [...scrollInner.querySelectorAll('.gridline')].forEach(x => x.remove());

    const frag = document.createDocumentFragment();

    const startAligned = new Date(timeMin);
    startAligned.setMinutes(0,0,0);
    const endMs = +timeMax;

    for (let t = +startAligned; t <= endMs; t += 10*minute) {
      const x = xForDate(t);
      const dt = new Date(t);
      const mm = dt.getMinutes();
      const isHour = (mm === 0);

      const g = el('div','gridline');
      g.style.left = `${x}px`;
      g.style.height = `${totalHeight}px`;
      if (!isHour) {
        g.classList.add('minor-tick'); // CSS already supports faint 10-min gridlines
      }
      frag.appendChild(g);
    }

    scrollInner.appendChild(frag);
  }

  // ------- update Now line -------
  function updateNowLine(totalHeight) {
    if (!nowLine) return;
    nowLine.style.left = `${xForDate(Date.now())}px`;
    nowLine.style.height = `${totalHeight}px`;
  }

  // ------- main row draw -------
  function drawRows() {
    rowsHost.innerHTML = '';
    const frag = document.createDocumentFragment();

    let totalHeight = 0;
    const beltsToShow = BELTS_ORDER.filter(b => beltFilter.size === 0 || beltFilter.has(b));

    // per belt row
    for (const b of beltsToShow) {
      const beltRow = el('div','belt-row');
      const beltName = el('div','belt-name'); beltName.textContent = `Belt ${b}`;
      const inner = el('div','row-inner');

      beltRow.appendChild(beltName);
      beltRow.appendChild(inner);

      // collect flights for this belt from flights (which is deduped)
      const items = flights.filter(r => r.belt === b);

      // pack vertically
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

    // scrollInner width
    const width = Math.max(xForDate(timeMax) + 200, scrollOuter.clientWidth);
    scrollInner.style.width = `${width}px`;

    addGridlines(totalHeight);
    updateNowLine(totalHeight);
  }

  // ------- full redraw -------
  function drawAll() {
    // Calculate filtered timeMin/timeMax already set in load()
    drawRuler();
    drawRows();
  }

  // ------- recompute time window (honours 4h history) -------
  function computeTimeWindow(allRows) {
    const nowMs = Date.now();
    const historyCutoff = nowMs - HISTORY_WINDOW_MIN * minute;

    // keep rows that are either still running / future OR ended within last 4h
    const visibleRows = allRows.filter(r => {
      const endMs = +new Date(r.end);
      return endMs >= historyCutoff;
    });

    // if nothing, default 90m window around now (unchanged logic style)
    if (!visibleRows.length) {
      const now = new Date();
      return {
        flightsFiltered: [],
        tMin: new Date(+now - 90*minute),
        tMax: new Date(+now + 90*minute),
      };
    }

    // find min start / max end across visibleRows
    const starts = visibleRows.map(r => +new Date(r.start || r.eta));
    const ends   = visibleRows.map(r => +new Date(r.end   || r.eta));
    const padMin = 45 * minute;
    const tMin = new Date(Math.min(...starts) - padMin);
    const tMax = new Date(Math.max(...ends)   + padMin);

    return { flightsFiltered: visibleRows, tMin, tMax };
  }

  // ------- load initial data -------
  function load() {
    return fetchJSON('assignments.json').then(data => {
      assignments = data;
      flightsRaw = (data.rows || []).slice();

      // 1. de-dupe
      const deduped = dedupeFlights(flightsRaw);

      // 2. compute visible (4h history, etc.)
      const { flightsFiltered, tMin, tMax } = computeTimeWindow(deduped);

      flights = flightsFiltered;
      timeMin = tMin;
      timeMax = tMax;

      if (meta) {
        meta.textContent = `Generated ${assignments.generated_at_local} • Horizon ${assignments.horizon_minutes} min`;
      }

      buildBeltChips();
      drawAll();
    });
  }

  // ------- belt filter chip UI (unchanged) -------
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

    [...beltChips.querySelectorAll('.chip')].forEach(c => c.classList.toggle('on', c.dataset.key === 'all'));
  }

  function toggleFilter(key) {
    if (key === 'all') { beltFilter.clear(); }
    else if (key === 'none') { beltFilter = new Set(['__none__']); }
    else {
      const n = parseInt(key, 10);
      if (Number.isFinite(n)) {
        if (beltFilter.has(n)) beltFilter.delete(n); else beltFilter.add(n);
      }
    }
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

  // ------- interactions / events (unchanged except default zoom already 8) -------
  zoomSel?.addEventListener('change', () => {
    pxPerMin = parseFloat(zoomSel.value || '8');
    drawAll();
  });

  nowBtn?.addEventListener('click', () => {
    const nowX = xForDate(Date.now());
    const viewW = scrollOuter.clientWidth;
    scrollOuter.scrollLeft = Math.max(0, nowX - viewW/2);
  });

  // keep now line refreshed
  scrollOuter.addEventListener('scroll', () => {
    // no-op for ruler sync; visual remains acceptable
  });

  window.addEventListener('resize', drawAll);
  setInterval(() => updateNowLine(rowsHost.getBoundingClientRect().height || 0), 30 * 1000);

  // live refresh (~90s)
  setInterval(() => {
    fetch('assignments.json', { cache: 'no-store' })
      .then(r => r.json())
      .then(data => {
        if (!data) return;
        const prevStamp = assignments?.generated_at_utc;
        assignments = data;
        flightsRaw = (data.rows || []).slice();

        const deduped = dedupeFlights(flightsRaw);
        const { flightsFiltered, tMin, tMax } = computeTimeWindow(deduped);

        flights = flightsFiltered;
        timeMin = tMin;
        timeMax = tMax;

        if (data.generated_at_utc !== prevStamp) {
          // window shifted
          drawAll();
        } else {
          drawAll();
        }
      })
      .catch(()=>{});
  }, 90 * 1000);

  // boot
  load().then(() => {
    const nowX = xForDate(Date.now());
    const viewW = scrollOuter.clientWidth;
    scrollOuter.scrollLeft = Math.max(0, nowX - viewW/2);
  });

})();
