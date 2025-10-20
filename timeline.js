/* docs/timeline.js — matches your timeline.html structure.
   Keeps original look. Tweak: flights on same belt must be >=45 min apart to share a lane. */

(function () {
  // ---------- helpers ----------
  const $ = (s) => document.querySelector(s);
  const el = (tag, cls) => { const n = document.createElement(tag); if (cls) n.className = cls; return n; };
  const minute = 60 * 1000;
  const fmt = (d) => { const t = new Date(d); return `${String(t.getHours()).padStart(2,'0')}:${String(t.getMinutes()).padStart(2,'0')}`; };

  // ---------- DOM (must exist) ----------
  const beltChips   = $('#beltChips');
  const zoomSel     = $('#zoom');
  const nowBtn      = $('#nowBtn');
  const meta        = $('#meta');

  const scrollOuter = $('#scrollOuter');
  const scrollInner = $('#scrollInner');
  const rowsHost    = $('#rows');
  const canvasRuler = $('#ruler');
  const nowLine     = $('#nowLine');

  // Guard: if any critical node is missing, tell us loudly
  const missing = [];
  [['#scrollOuter',scrollOuter],['#scrollInner',scrollInner],['#rows',rowsHost],['#ruler',canvasRuler],['#nowLine',nowLine]].forEach(([n,ref])=>{
    if (!ref) missing.push(n);
  });
  if (missing.length) {
    console.error('Timeline: required elements missing:', missing.join(', '));
    return;
  }

  // ---------- state ----------
  const BELTS = [1,2,3,5,6,7];
  let assignments = null;
  let flights = [];
  let pxPerMin = parseFloat(zoomSel?.value || '6');
  let timeMin = null, timeMax = null;
  let beltFilter = new Set(); // empty => all
  const MIN_SEP = 45 * minute;

  // read CSS variables (fallbacks keep the look even if not found)
  const cssNum = (name,fallback) => {
    const v = parseInt(getComputedStyle(document.documentElement).getPropertyValue(name),10);
    return Number.isFinite(v) ? v : fallback;
  };
  const LANE_H   = cssNum('--lane-height', 58);
  const LANE_GAP = cssNum('--lane-gap', 10);
  const BELT_PAD = cssNum('--belt-pad-y', 18);

  // ---------- data ----------
  function load() {
    return fetch('assignments.json', {cache:'no-store'})
      .then(r => {
        if (!r.ok) throw new Error('assignments.json HTTP ' + r.status);
        return r.json();
      })
      .then(data => {
        assignments = data;
        flights = (data.rows || []).slice();

        if (flights.length) {
          const starts = flights.map(f => +new Date(f.start || f.eta));
          const ends   = flights.map(f => +new Date(f.end   || f.eta));
          const pad = 45 * minute;
          timeMin = new Date(Math.min(...starts) - pad);
          timeMax = new Date(Math.max(...ends)   + pad);
        } else {
          const now = Date.now();
          timeMin = new Date(now - 90*minute);
          timeMax = new Date(now + 90*minute);
        }

        if (meta) meta.textContent = `Generated ${data.generated_at_local} • Horizon ${data.horizon_minutes} min`;

        buildBeltChips();
        drawAll();
      })
      .catch(err => {
        console.error('Timeline: failed to load assignments.json', err);
        rowsHost.textContent = 'Failed to load assignments.json';
      });
  }

  // ---------- belt chips ----------
  function buildBeltChips(){
    if (!beltChips) return;
    beltChips.innerHTML = '';
    const frag = document.createDocumentFragment();
    const mk = (label,key) => {
      const b = el('button','chip'); b.textContent = label; b.dataset.key = key;
      b.addEventListener('click', ()=>toggleFilter(key));
      frag.appendChild(b);
    };
    BELTS.forEach(n => mk(`Belt ${n}`, String(n)));
    mk('All','all'); mk('None','none');
    beltChips.appendChild(frag);
    updateChipVisuals();
  }
  function toggleFilter(key){
    if (key === 'all') beltFilter.clear();
    else if (key === 'none') beltFilter = new Set(['__none__']);
    else {
      const n = parseInt(key,10);
      if (Number.isFinite(n)) { beltFilter.has(n) ? beltFilter.delete(n) : beltFilter.add(n); }
    }
    updateChipVisuals();
    drawAll();
  }
  function updateChipVisuals(){
    if (!beltChips) return;
    [...beltChips.querySelectorAll('.chip')].forEach(c=>{
      const k = c.dataset.key;
      const on =
        (k === 'all'  && beltFilter.size === 0) ||
        (k === 'none' && beltFilter.has('__none__')) ||
        (/^\d+$/.test(k) && beltFilter.has(parseInt(k,10)));
      c.classList.toggle('on', on);
    });
  }

  // ---------- geometry ----------
  const xFor = d => ((+new Date(d)) - (+timeMin)) / 60000 * pxPerMin;

  function pack(items){
    const sorted = items.slice().sort((a,b)=>+new Date(a.start)-+new Date(b.start));
    const ends = []; // per-lane last end (ms)
    for (const f of sorted){
      const s = +new Date(f.start), e = +new Date(f.end);
      let lane = -1;
      for (let i=0;i<ends.length;i++){
        if (s >= (ends[i] + MIN_SEP)) { lane = i; break; }
      }
      if (lane === -1){ lane = ends.length; ends.push(e); } else { ends[lane] = e; }
      f._lane = lane;
    }
    return {lanes: Math.max(1, ends.length), items: sorted};
  }

  // ---------- draw ----------
  function drawRuler(){
    const ctx = canvasRuler.getContext('2d');
    const width  = Math.max(xFor(timeMax) + 200, scrollOuter.clientWidth);
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

    const start = new Date(timeMin); start.setMinutes(0,0,0);
    for (let t=+start; t<=+timeMax; t+=60*minute){
      const x = Math.floor(xFor(t));
      ctx.fillStyle = '#213043'; ctx.fillRect(x,0,1,height);
      ctx.fillStyle = '#dce6f2'; ctx.fillText(fmt(t), x+8, height-12);
    }
  }

  function puckNode(f){
    const n = el('div', `puck ${delayClass(f.delay_min)}`);
    const t = el('div','title'); t.textContent = `${(f.flight||'').trim()} • ${(f.origin_iata||'').trim() || f.origin || ''}`.replace(/\s+/g,' ');
    const s = el('div','sub');   s.textContent = `${fmt(f.start)} → ${fmt(f.end)}`;
    const tip = [
      `${(f.flight||'').trim()} ${f.origin ? `• ${f.origin}` : ''}`,
      `${fmt(f.start)} → ${fmt(f.end)}`,
      f.flow, f.airline, f.aircraft, f.reason ? `Reason: ${f.reason}` : ''
    ].filter(Boolean).join('\n');
    n.setAttribute('data-tip', tip);
    n.appendChild(t); n.appendChild(s);

    const left = xFor(f.start), right = xFor(f.end);
    n.style.left  = `${left}px`;
    n.style.width = `${Math.max(120, right-left-4)}px`;
    n.style.top   = `${f._lane * (LANE_H + LANE_GAP)}px`;
    return n;
  }

  function delayClass(d){
    if (d == null) return 'ok';
    if (d >= 20) return 'late';
    if (d >= 10) return 'mid';
    if (d <= -1)  return 'early';
    return 'ok';
  }

  function drawRows(){
    rowsHost.innerHTML = '';
    const belts = BELTS.filter(b => beltFilter.size===0 || beltFilter.has(b));
    const frag = document.createDocumentFragment();

    // Build rows first (so we can measure height after append)
    for (const b of belts){
      const row = el('div','belt-row');
      const name = el('div','belt-name'); name.textContent = `Belt ${b}`;
      const inner = el('div','row-inner');
      row.appendChild(name); row.appendChild(inner);

      const items = flights.filter(f => f.belt === b);
      const {lanes, items: packed} = pack(items);
      const contentH = lanes * (LANE_H + LANE_GAP) - LANE_GAP;
      row.style.minHeight = `calc(${BELT_PAD}px * 2 + ${contentH}px)`;
      for (const f of packed) inner.appendChild(puckNode(f));
      frag.appendChild(row);
    }

    // If no belts/rows to show, indicate empty state
    if (!belts.length || rowsHost.childElementCount === 0 && frag.childElementCount === 0){
      rowsHost.textContent = 'No flights to show in this window.';
    }

    rowsHost.appendChild(frag);

    // compute total height now that rows are in DOM
    let totalH = 0;
    rowsHost.querySelectorAll('.belt-row').forEach(r => totalH += r.getBoundingClientRect().height);

    // content width
    const width = Math.max(xFor(timeMax) + 200, scrollOuter.clientWidth);
    scrollInner.style.width = `${width}px`;

    // gridlines
    [...scrollInner.querySelectorAll('.gridline')].forEach(x => x.remove());
    const start = new Date(timeMin); start.setMinutes(0,0,0);
    const gfrag = document.createDocumentFragment();
    for (let t=+start; t<=+timeMax; t+=60*minute){
      const x = xFor(t);
      const g = el('div','gridline'); g.style.left = `${x}px`; g.style.height = `${totalH}px`;
      gfrag.appendChild(g);
    }
    scrollInner.appendChild(gfrag);

    // now line
    nowLine.style.left = `${xFor(Date.now())}px`;
    nowLine.style.height = `${totalH}px`;
  }

  function drawAll(){ drawRuler(); drawRows(); }

  // ---------- interactions ----------
  zoomSel && zoomSel.addEventListener('change', ()=>{ pxPerMin = parseFloat(zoomSel.value || '6'); drawAll(); });
  nowBtn && nowBtn.addEventListener('click', ()=>{
    const x = xFor(Date.now());
    const view = scrollOuter.clientWidth;
    scrollOuter.scrollLeft = Math.max(0, x - view/2);
  });
  window.addEventListener('resize', drawAll);
  setInterval(()=>{ // keep Now line creeping
    const h = rowsHost.getBoundingClientRect().height || 0;
    nowLine.style.left = `${xFor(Date.now())}px`;
    nowLine.style.height = `${h}px`;
  }, 30000);

  // live refresh as before
  setInterval(()=>{ fetch('assignments.json',{cache:'no-store'}).then(r=>r.json()).then(d=>{
    const prev = assignments?.generated_at_utc; assignments = d; flights = (d.rows||[]).slice();
    if (d.generated_at_utc !== prev) load(); else drawAll();
  }).catch(()=>{}); }, 90000);

  // ---------- boot ----------
  load().then(()=>{
    const x = xFor(Date.now());
    const view = scrollOuter.clientWidth;
    scrollOuter.scrollLeft = Math.max(0, x - view/2);
  });
})();
