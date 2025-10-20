/* docs/timeline.js
 * Professional gantt:
 * - Fixed left belt column (independent from horizontal scroll)
 * - Hour grid + faint 10-minute minor ticks
 * - Tight vertical packing; no oversized gaps
 * - Fonts/layout don’t scale with zoom (only geometry does)
 */
(function(){
  const $ = sel => document.querySelector(sel);
  const CE = (t, c) => { const n = document.createElement(t); if (c) n.className = c; return n; };

  // DOM
  const beltChips   = $('#beltChips');
  const zoomSel     = $('#zoom');
  const nowBtn      = $('#nowBtn');
  const meta        = $('#meta');

  const beltsCol    = $('#beltsCol');
  const scrollOuter = $('#scrollOuter');
  const scrollInner = $('#scrollInner');
  const rowsHost    = $('#rows');
  const canvasRuler = /** @type {HTMLCanvasElement} */($('#ruler'));
  const nowLine     = $('#nowLine');

  // Settings
  const BELTS_ORDER = [1,2,3,5,6,7];
  const minute = 60*1000;
  const MIN_SEPARATION_MS = 45*minute; // flights within 45min go into separate vertical lanes

  // CSS numbers
  const cssNum = (name, fallback) => {
    const v = parseInt(getComputedStyle(document.documentElement).getPropertyValue(name), 10);
    return Number.isFinite(v) ? v : fallback;
  };
  const LANE_H   = cssNum('--lane-height', 58);
  const LANE_GAP = cssNum('--lane-gap', 10);
  const BELT_PAD = cssNum('--belt-pad-y', 14);

  // State
  let pxPerMin = parseFloat(zoomSel?.value || '6');
  let assignments = null;
  let flights = [];
  let belts = BELTS_ORDER.slice();
  let beltFilter = new Set(); // empty => show all
  let timeMin = null, timeMax = null;

  // Utils
  const dFmt = d => {
    const dt = new Date(d);
    return `${String(dt.getHours()).padStart(2,'0')}:${String(dt.getMinutes()).padStart(2,'0')}`;
  };
  const xFor = (d) => ((+new Date(d)) - (+timeMin)) / 60000 * pxPerMin;

  const fetchJSON = (url) => fetch(url, {cache:'no-store'}).then(r=>r.json());

  function load(){
    return fetchJSON('assignments.json').then(data=>{
      assignments = data;
      flights = (data.rows || []).slice();

      // work out belts present (keep order)
      const seen = new Set(flights.map(r=>r.belt).filter(b => b !== undefined && b !== null && b !== ''));
      const order = BELTS_ORDER.filter(b=>seen.has(b));
      belts = order.length ? order : BELTS_ORDER.slice();

      // window
      if (flights.length){
        const starts = flights.map(r=>+new Date(r.start || r.eta));
        const ends   = flights.map(r=>+new Date(r.end   || r.eta));
        const pad = 60*minute;
        timeMin = new Date(Math.min(...starts) - pad);
        timeMax = new Date(Math.max(...ends)   + pad);
      } else {
        const now = Date.now();
        timeMin = new Date(now - 90*minute);
        timeMax = new Date(now + 90*minute);
      }

      if (meta) meta.textContent = `Generated ${assignments.generated_at_local} • Horizon ${assignments.horizon_minutes} min`;

      buildChips();
      drawAll(true);
    });
  }

  // Belt filter chips
  function buildChips(){
    if (!beltChips) return;
    beltChips.innerHTML = '';
    const f = document.createDocumentFragment();
    const mk = (label, key) => {
      const b = CE('button','chip'); b.textContent = label; b.dataset.key = key;
      b.addEventListener('click', ()=>toggleFilter(key));
      f.appendChild(b);
    };
    BELTS_ORDER.forEach(n=>mk(`Belt ${n}`, String(n)));
    mk('All','all'); mk('None','none');
    beltChips.appendChild(f);
    updateChipVisuals();
  }
  function toggleFilter(key){
    if (key==='all'){ beltFilter.clear(); }
    else if (key==='none'){ beltFilter = new Set(['__none__']); }
    else {
      const n = parseInt(key,10);
      if (Number.isFinite(n)){
        if (beltFilter.has(n)) beltFilter.delete(n); else beltFilter.add(n);
      }
    }
    updateChipVisuals();
    drawAll(false);
  }
  function updateChipVisuals(){
    [...beltChips.querySelectorAll('.chip')].forEach(c=>{
      const k = c.dataset.key;
      const on =
        (k==='all'  && beltFilter.size===0) ||
        (k==='none' && beltFilter.has('__none__')) ||
        (/^\d+$/.test(k) && beltFilter.has(parseInt(k,10)));
      c.classList.toggle('on', on);
    });
  }

  // Packing per belt: assign vertical lane indexes, requiring 45min separation for same lane
  function packLanes(items){
    const sorted = items.slice().sort((a,b)=>+new Date(a.start) - +new Date(b.start));
    const lanesEnd = []; // ms
    for (const f of sorted){
      const s = +new Date(f.start), e = +new Date(f.end);
      let lane = -1;
      for (let i=0;i<lanesEnd.length;i++){
        if (s >= lanesEnd[i] + MIN_SEPARATION_MS){ lane = i; break; }
      }
      if (lane === -1){ lane = lanesEnd.length; lanesEnd.push(e); }
      else lanesEnd[lane] = e;
      f._lane = lane;
    }
    return {lanes: Math.max(1, lanesEnd.length), items: sorted};
  }

  // Puck DOM
  function delayClass(d){
    if (d==null) return 'ok';
    if (d>=20) return 'late';
    if (d>=10) return 'mid';
    if (d<=-1) return 'early';
    return 'ok';
  }
  function buildPuck(f){
    const p = CE('div', `puck ${delayClass(f.delay_min)}`);
    const title = CE('div','title');
    title.textContent = `${(f.flight||'').trim()} • ${(f.origin_iata||'').trim() || f.origin || ''}`.replace(/\s+/g,' ');
    const sub = CE('div','sub'); sub.textContent = `${dFmt(f.start)} → ${dFmt(f.end)}`;
    const tipLines = [
      `${(f.flight||'').trim()} ${f.origin ? `• ${f.origin}` : ''}`,
      `${dFmt(f.start)} → ${dFmt(f.end)}`,
      f.flow, f.airline, f.aircraft,
      f.reason ? `Reason: ${f.reason}` : ''
    ].filter(Boolean);
    p.setAttribute('data-tip', tipLines.join('\n'));
    p.appendChild(title); p.appendChild(sub);

    const x1 = xFor(f.start), x2 = xFor(f.end);
    p.style.left = `${x1}px`;
    p.style.width = `${Math.max(120, x2 - x1 - 4)}px`;
    p.style.top = `${f._lane * (LANE_H + LANE_GAP)}px`;
    return p;
  }

  // Build both columns: left belt labels and right rows with same heights
  function drawRowsAndBelts(){
    rowsHost.innerHTML = '';
    beltsCol.innerHTML = '';

    const beltsToShow = belts.filter(b => beltFilter.size===0 || beltFilter.has(b));
    const fragRows = document.createDocumentFragment();
    const fragBelts = document.createDocumentFragment();

    let totalHeight = 0;

    for (const b of beltsToShow){
      // Right row
      const row = CE('div','row');
      const items = flights.filter(r => r.belt === b);
      const {lanes, items: packed} = packLanes(items);

      // exact content height to avoid big gaps
      const contentH = lanes * LANE_H + Math.max(0, lanes-1) * LANE_GAP;
      const rowH = (BELT_PAD*2) + contentH;
      row.style.height = `${rowH}px`;

      for (const f of packed){
        row.appendChild(buildPuck(f));
      }
      fragRows.appendChild(row);

      // Left label with same height
      const lab = CE('div','belt-label'); lab.textContent = `Belt ${b}`;
      lab.style.height = `${rowH}px`;
      fragBelts.appendChild(lab);

      totalHeight += rowH;
    }

    rowsHost.appendChild(fragRows);
    beltsCol.appendChild(fragBelts);

    // Width of scroll content
    const contentW = Math.max(xFor(timeMax) + 200, scrollOuter.clientWidth);
    scrollInner.style.width = `${contentW}px`;

    // Gridlines (hour + 10-min)
    drawGridlines(totalHeight);

    // Now line height/position
    updateNowLine(totalHeight);
  }

  function drawGridlines(totalHeight){
    // clear
    [...scrollInner.querySelectorAll('.gridline')].forEach(x=>x.remove());

    const start = new Date(timeMin);
    start.setMinutes(0,0,0);
    const endMs = +new Date(timeMax);

    const frag = document.createDocumentFragment();
    for (let t = +start; t <= endMs; t += 10*minute){
      const x = Math.floor(xFor(t));
      const gl = CE('div', 'gridline' + ((t - (+start)) % (60*minute) === 0 ? '' : ' minor'));
      gl.style.left = `${x}px`;
      gl.style.height = `${totalHeight}px`;
      frag.appendChild(gl);
    }
    scrollInner.appendChild(frag);

    // Ruler
    drawRuler();
  }

  function drawRuler(){
    const ctx = canvasRuler.getContext('2d');
    const width = Math.max(xFor(timeMax) + 200, scrollOuter.clientWidth);
    const height = 44;
    const dpr = window.devicePixelRatio || 1;
    canvasRuler.width = Math.floor(width*dpr);
    canvasRuler.height = Math.floor(height*dpr);
    canvasRuler.style.width = `${width}px`;
    canvasRuler.style.height = `${height}px`;
    ctx.setTransform(dpr,0,0,dpr,0,0);

    // bg + bottom border
    ctx.clearRect(0,0,width,height);
    ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--panel') || '#111b26';
    ctx.fillRect(0,0,width,height);
    ctx.strokeStyle = '#1a2a3a';
    ctx.beginPath(); ctx.moveTo(0,height-1); ctx.lineTo(width,height-1); ctx.stroke();

    // ticks
    const start = new Date(timeMin); start.setMinutes(0,0,0);
    for (let t = +start; t <= +timeMax; t += 60*minute){
      const x = Math.floor(xFor(t));
      // major tick
      ctx.fillStyle = '#213043';
      ctx.fillRect(x, 0, 1, height);
      // label
      ctx.fillStyle = '#dce6f2';
      ctx.font = '14px ui-sans-serif, system-ui, Segoe UI, Roboto, Arial';
      ctx.textBaseline = 'alphabetic';
      ctx.fillText(dFmt(t), x + 8, height - 12);
    }
  }

  function updateNowLine(totalHeight){
    if (!nowLine) return;
    nowLine.style.left = `${xFor(Date.now())}px`;
    nowLine.style.height = `${totalHeight}px`;
  }

  function drawAll(resetScroll){
    drawRowsAndBelts();
    if (resetScroll){
      // center Now on first paint
      const nowX = xFor(Date.now());
      const viewW = scrollOuter.clientWidth;
      scrollOuter.scrollLeft = Math.max(0, nowX - viewW/2);
    } else {
      // keep current scroll
    }
  }

  // Events
  zoomSel?.addEventListener('change', ()=>{
    pxPerMin = parseFloat(zoomSel.value || '6');
    drawAll(false);
  });
  nowBtn?.addEventListener('click', ()=>{
    const nowX = xFor(Date.now());
    const viewW = scrollOuter.clientWidth;
    scrollOuter.scrollLeft = Math.max(0, nowX - viewW/2);
  });

  // Keep left belt column vertically aligned to right scroll (share scrollTop)
  scrollOuter.addEventListener('scroll', ()=>{
    // vertical sync
    beltsCol.scrollTop = scrollOuter.scrollTop;
  });
  window.addEventListener('resize', ()=>drawAll(false));

  // Light now-line creep
  setInterval(()=>updateNowLine(rowsHost.getBoundingClientRect().height || 0), 30*1000);

  // Auto refresh ~90s (redraw window if the timestamp changed)
  setInterval(()=>{
    fetch('assignments.json', {cache:'no-store'}).then(r=>r.json()).then(data=>{
      const prev = assignments?.generated_at_utc;
      assignments = data;
      flights = (data.rows || []).slice();
      if (data.generated_at_utc !== prev) load(); else drawAll(false);
    }).catch(()=>{});
  }, 90*1000);

  // Boot
  load();
})();
