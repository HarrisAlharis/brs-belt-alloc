/* docs/timeline.js
 * Renders assignments.json into a horizontally scrollable, lane-packed belt timeline.
 * No HTML changes required.
 */

(function(){
  const Q = sel => document.querySelector(sel);
  const CE = (tag, cls) => { const n = document.createElement(tag); if (cls) n.className = cls; return n; };

  // --- DOM references (expected IDs/classes in your existing HTML) ---
  const scroller   = Q('#scroller');        // main scroll container
  const grid       = Q('#grid');            // big grid (inside scroller)
  const ruler      = Q('#ruler-inner');     // top ruler inner div
  const headerGen  = Q('#generatedAt');     // "Generated" text span
  const nowBtn     = Q('#btnNow');          // Now button
  const zoomSel    = Q('#zoomSelect');      // select for px/min
  const beltBadges = [...document.querySelectorAll('[data-belt-filter]')];

  // --- Config / state ---
  const pxPerMinDefault = 6;
  const laneH    = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--lane-height')) || 58;
  const laneGap  = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--lane-gap')) || 10;
  const beltPadY = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--belt-pad-y')) || 18;

  let pxPerMin = parseFloat(zoomSel?.value || pxPerMinDefault);
  let assignments = null;
  let rows = [];           // flights
  let beltsInUse = [];     // [1,2,3,5,6,7]
  let timeMin = null, timeMax = null; // Date
  let x0 = 0;              // left origin
  let filterBelts = new Set(); // empty -> show all

  const minute = 60*1000;

  // NEW: minimum separation to treat a lane as "free" (prevents overlap/near-overlap)
  const MIN_SEPARATION_MIN = 45;                 // <— tweak requested
  const MIN_SEPARATION_MS  = MIN_SEPARATION_MIN * minute;

  // daylight-safe local formatting
  const dFmt = (d) => {
    const dt = new Date(d);
    const hh = String(dt.getHours()).padStart(2,'0');
    const mm = String(dt.getMinutes()).padStart(2,'0');
    return `${hh}:${mm}`;
  };

  function fetchJSON(url){ return fetch(url, {cache:'no-store'}).then(r => r.json()); }

  function load(){
    return fetchJSON('assignments.json').then(data => {
      assignments = data;
      rows = data.rows || [];
      // infer belts actually present (but keep order 1,2,3,5,6,7)
      const seen = new Set(rows.map(r => r.belt).filter(Boolean));
      beltsInUse = [1,2,3,5,6,7].filter(b => seen.has(b));
      if (beltsInUse.length === 0) beltsInUse = [1,2,3,5,6,7];

      // build time span (add padding)
      if (rows.length){
        const starts = rows.map(r => +new Date(r.start || r.eta));
        const ends   = rows.map(r => +new Date(r.end   || r.eta));
        const padMin = 45;
        const minT = Math.min(...starts) - padMin*minute;
        const maxT = Math.max(...ends)   + padMin*minute;
        timeMin = new Date(minT);
        timeMax = new Date(maxT);
      } else {
        const now = Date.now();
        timeMin = new Date(now - 90*minute);
        timeMax = new Date(now + 90*minute);
      }

      headerGen && (headerGen.textContent =
        `Generated ${assignments.generated_at_local} • Horizon ${assignments.horizon_minutes} min`);

      draw();
    });
  }

  function xForDate(d){
    const ms = (+new Date(d)) - (+timeMin);
    return (ms/60000) * pxPerMin + x0;
  }

  function buildRuler(){
    if (!ruler) return;
    ruler.innerHTML = '';
    const start = new Date(timeMin);
    start.setMinutes(0,0,0);
    const endMs = +new Date(timeMax);

    for (let t = +start; t <= endMs; t += 60*minute){
      const x = xForDate(t);
      const tick = CE('div','rtick'); tick.style.left = `${x}px`;
      const lab = CE('div','lab'); lab.textContent = dFmt(t);
      tick.appendChild(lab);
      ruler.appendChild(tick);
    }
  }

  function buildGridlines(height){
    const start = new Date(timeMin);
    start.setMinutes(0,0,0);
    const endMs = +new Date(timeMax);
    const frag = document.createDocumentFragment();

    for (let t = +start; t <= endMs; t += 60*minute){
      const x = xForDate(t);
      const gl = CE('div','gridline');
      gl.style.left = `${x}px`;
      gl.style.height = `${height}px`;
      frag.appendChild(gl);
    }
    grid.appendChild(frag);
  }

  function classifyDelay(dmin){
    if (dmin == null) return 'ok';
    if (dmin >= 20) return 'late';
    if (dmin >= 10) return 'mid';
    if (dmin <= -1)  return 'early';
    return 'ok';
  }

  // lane packing for one belt
  // TWEAK: a lane is "free" only if start >= (lastEnd + MIN_SEPARATION_MS)
  function packLanes(flightsForBelt){
    const items = flightsForBelt.slice().sort((a,b)=>+new Date(a.start) - +new Date(b.start));
    const lanes = []; // each lane: lastEndMs

    for (const f of items){
      const startMs = +new Date(f.start);
      const endMs   = +new Date(f.end);
      let placedLane = -1;

      for (let li=0; li<lanes.length; li++){
        const lastEnd = lanes[li];
        if (startMs >= (lastEnd + MIN_SEPARATION_MS)){ // <-- key change
          placedLane = li; break;
        }
      }
      if (placedLane === -1){
        lanes.push(endMs); // new lane
        f._lane = lanes.length - 1;
      } else {
        lanes[placedLane] = endMs;
        f._lane = placedLane;
      }
    }

    return { lanesCount: lanes.length || 1, items };
  }

  function buildPuck(f){
    const delayClass = classifyDelay(f.delay_min);
    const p = CE('div', `puck ${delayClass}`);

    const title = CE('div','title');
    title.textContent = `${(f.flight||'').trim()} • ${(f.origin_iata||'').trim() || f.origin || ''}`.replace(/\s+/g,' ');
    const sub = CE('div','sub');
    sub.textContent = `${dFmt(f.start)} → ${dFmt(f.end)}`;

    const tipLines = [
      `${(f.flight||'').trim()}  ${f.origin ? `• ${f.origin}` : ''}`,
      `${dFmt(f.start)} → ${dFmt(f.end)}`,
      f.flow ? f.flow : '',
      f.airline ? f.airline : '',
      f.aircraft ? f.aircraft : '',
      f.reason ? `Reason: ${f.reason}` : ''
    ].filter(Boolean);
    p.setAttribute('data-tip', tipLines.join('\n'));

    p.appendChild(title);
    p.appendChild(sub);

    // horizontal position/width
    const x1 = xForDate(f.start), x2 = xForDate(f.end);
    const width = Math.max(120, x2 - x1 - 4);
    p.style.left = `${x1}px`;
    p.style.width = `${width}px`;

    // vertical lane offset
    p.style.top = `${f._lane * (laneH + laneGap)}px`;

    return p;
  }

  function draw(){
    grid.innerHTML = '';
    buildRuler();

    const nowX = xForDate(Date.now());
    const frag = document.createDocumentFragment();
    let totalHeight = 0;

    const belts = [1,2,3,5,6,7];
    for (const b of belts){
      if (filterBelts.size && !filterBelts.has(b)) continue;

      const row = CE('div','belt-row');
      const name = CE('div','belt-name'); name.textContent = `Belt ${b}`;
      const inner = CE('div','row-inner');

      row.appendChild(name);
      row.appendChild(inner);

      const items = rows.filter(r => r.belt === b);
      const { lanesCount, items: packed } = packLanes(items);

      const contentH = lanesCount * (laneH + laneGap) - laneGap; // last lane no gap
      row.style.minHeight = `calc(var(--belt-pad-y)*2 + ${contentH}px)`;

      for (const f of packed){
        const puck = buildPuck(f);
        inner.appendChild(puck);
      }

      if (totalHeight === 0){
        const nl = CE('div','nowline');
        nl.style.left = `${nowX}px`;
        nl.style.height = `calc(100% - 0px)`;
        nl.id = 'nowline';
        grid.appendChild(nl);
      }

      frag.appendChild(row);
      totalHeight += row.getBoundingClientRect().height;
    }

    grid.appendChild(frag);

    const gridWidth = xForDate(timeMax) + 200;
    grid.style.width = `${gridWidth}px`;

    buildGridlines(totalHeight);

    const nl = Q('#nowline');
    if (nl) nl.style.height = `${totalHeight}px`;
  }

  function onZoom(){
    pxPerMin = parseFloat(zoomSel.value || pxPerMinDefault);
    draw();
  }

  function onNow(){
    const nowX = xForDate(Date.now());
    const view = scroller.getBoundingClientRect().width;
    scroller.scrollLeft = Math.max(0, nowX - view/2);
  }

  function applyFilter(b){
    if (b === 'all'){ filterBelts.clear(); }
    else if (b === 'none'){ filterBelts = new Set([999]); }
    else {
      const n = parseInt(b,10);
      if (Number.isFinite(n)){
        if (filterBelts.has(n)) filterBelts.delete(n);
        else filterBelts.add(n);
      }
    }
    beltBadges.forEach(el=>{
      const key = el.getAttribute('data-belt-filter');
      if (key === 'all' && filterBelts.size===0) el.classList.add('is-on');
      else if (key === 'none' && filterBelts.size>0 && [...filterBelts][0]===999) el.classList.add('is-on');
      else if (/^\d+$/.test(key) && filterBelts.has(parseInt(key,10))) el.classList.add('is-on');
      else el.classList.remove('is-on');
    });
    draw();
  }

  function startAutoRefresh(){
    setInterval(()=>{
      fetch('assignments.json', {cache:'no-store'})
        .then(r=>r.json())
        .then(data=>{
          const prevStamp = assignments?.generated_at_utc;
          assignments = data;
          rows = data.rows || [];
          if (data.generated_at_utc !== prevStamp){
            load();
          } else {
            draw();
          }
        }).catch(()=>{ /* ignore transient */ });
    }, 90000);
  }

  zoomSel && zoomSel.addEventListener('change', onZoom);
  nowBtn && nowBtn.addEventListener('click', onNow);
  beltBadges.forEach(b=>{
    b.addEventListener('click', ()=>applyFilter(b.getAttribute('data-belt-filter')));
  });

  load().then(()=>{
    startAutoRefresh();
    onNow();
  });
})();
