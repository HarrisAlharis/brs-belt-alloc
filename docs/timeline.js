/* BRS timeline
 * Minimal layout changes only:
 * - “pro” header restored
 * - pucks sit at top of belt row
 * - keep 4h history locally; grey anything that ended >2min ago
 * - belts 1,2,3,5,6,7 always shown
 * - min zoom = 8 px/min
 */
(function(){
  const $ = s => document.querySelector(s);
  const CE = (tag, cls) => { const n=document.createElement(tag); if(cls) n.className=cls; return n; };
  const minute = 60*1000;

  // DOM
  const meta        = $('#meta');
  const beltChips   = $('#beltChips');
  const zoomSel     = $('#zoom');
  const nowBtn      = $('#nowBtn');
  const scrollOuter = $('#scrollOuter');
  const scrollInner = $('#scrollInner');
  const rowsHost    = $('#rows');
  const rulerCanvas = /** @type {HTMLCanvasElement} */($('#ruler'));
  const nowLine     = $('#nowLine');
  const beltsCol    = $('#beltsCol');

  // State
  const BELTS = [1,2,3,5,6,7];
  let pxPerMin = Math.max(8, parseFloat(zoomSel?.value || '8'));
  let timeMin = null, timeMax = null;
  let liveRows = [];
  let mergedRows = [];
  let beltFilter = new Set(); // empty => all

  // utils
  const hhmm = d => {
    const dt = new Date(d);
    return `${String(dt.getHours()).padStart(2,'0')}:${String(dt.getMinutes()).padStart(2,'0')}`;
  };
  const xForDate = d => ((+new Date(d)) - (+timeMin)) / 60000 * pxPerMin;

  // --------- HISTORY (4h) ----------
  const HIST_KEY = 'brs_belt_history_v1';
  function loadHistory(){
    try { return JSON.parse(localStorage.getItem(HIST_KEY) || '[]'); }
    catch{ return []; }
  }
  function saveHistory(arr){
    try { localStorage.setItem(HIST_KEY, JSON.stringify(arr)); } catch{}
  }
  function mergeWithHistory(rows){
    const now = Date.now();
    const cutoff = now - 4*60*minute;

    const hist = loadHistory().filter(r => +new Date(r.end||r.eta||0) >= cutoff);
    const all = [...rows, ...hist];

    // de-dup by flight + start (most stable)
    const map = new Map();
    for(const r of all){
      const key = `${r.flight||''}|${r.start||r.eta||''}|${r.belt||''}`;
      // prefer the "live" row if duplicate
      if(!map.has(key) || rows.includes(r)) map.set(key, r);
    }
    const merged = [...map.values()];

    // persist merged for next runs
    const toStore = merged.filter(r => +new Date(r.end||r.eta||0) >= cutoff);
    saveHistory(toStore);

    return merged;
  }

  // --------- DATA LOAD ----------
  function fetchJSON(u){ return fetch(u, {cache:'no-store'}).then(r=>r.json()); }

  function buildBeltChips(){
    beltChips.innerHTML='';
    const frag = document.createDocumentFragment();
    const mk = (label, key) => {
      const b = CE('button','chip'); b.textContent = label; b.dataset.key = key;
      b.addEventListener('click', ()=>toggleFilter(key));
      frag.appendChild(b);
    };
    BELTS.forEach(n => mk(`Belt ${n}`, String(n)));
    mk('All', 'all'); mk('None', 'none');
    beltChips.appendChild(frag);
    syncChipUI();
  }
  function toggleFilter(key){
    if(key==='all'){ beltFilter.clear(); }
    else if(key==='none'){ beltFilter = new Set(['__none__']); }
    else{
      const n = parseInt(key,10);
      if(Number.isFinite(n)){
        if(beltFilter.has(n)) beltFilter.delete(n); else beltFilter.add(n);
      }
    }
    syncChipUI();
    drawAll();
  }
  function syncChipUI(){
    [...beltChips.querySelectorAll('.chip')].forEach(c=>{
      const k=c.dataset.key;
      const on=(k==='all'&&beltFilter.size===0)||
               (k==='none'&&beltFilter.has('__none__'))||
               (/^\d+$/.test(k)&&beltFilter.has(parseInt(k,10)));
      c.classList.toggle('on', on);
    });
  }

  function load(){
    return fetchJSON('assignments.json?v='+Date.now()).then(data=>{
      liveRows = Array.isArray(data.rows) ? data.rows : [];
      mergedRows = mergeWithHistory(liveRows);

      // time window: include up to 4h before now
      const now = Date.now();
      const pad = 45*minute;
      if(mergedRows.length){
        const starts = mergedRows.map(r => +new Date(r.start || r.eta));
        const ends   = mergedRows.map(r => +new Date(r.end   || r.eta));
        const minFromData = Math.min(...starts) - pad;
        const minFromHistory = now - 4*60*minute;
        timeMin = new Date(Math.min(minFromData, minFromHistory));
        timeMax = new Date(Math.max(...ends) + pad);
      }else{
        timeMin = new Date(now - 4*60*minute);
        timeMax = new Date(now + 90*minute);
      }

      // meta
      if(meta) meta.textContent = `Generated ${data.generated_at_local || data.generated_at_utc || ''} • Horizon ${data.horizon_minutes || ''} min`;

      // left belt labels
      beltsCol.innerHTML='';
      for(const b of BELTS){
        const lab = CE('div','belt-label'); lab.textContent = `Belt ${b}`;
        beltsCol.appendChild(lab);
      }

      buildBeltChips();
      drawAll();
    });
  }

  // --------- DRAW ----------
  function classifyDelay(dmin){
    if(dmin==null) return 'ok';
    if(dmin >= 20) return 'late';
    if(dmin >= 10) return 'mid';
    if(dmin <= -1) return 'early';
    return 'ok';
  }

  function packLanes(items){
    const sorted = items.slice().sort((a,b)=>+new Date(a.start)-+new Date(b.start));
    const lanesLastEnd = [];
    for(const f of sorted){
      const s = +new Date(f.start);
      const e = +new Date(f.end);
      let lane = -1;
      for(let i=0;i<lanesLastEnd.length;i++){
        if(s >= lanesLastEnd[i]){ lane = i; break; }
      }
      if(lane===-1){ lane = lanesLastEnd.length; lanesLastEnd.push(e); }
      else{ lanesLastEnd[lane] = e; }
      f._lane = lane;
    }
    return {lanes: Math.max(1, lanesLastEnd.length), items: sorted};
  }

  function buildPuck(r){
    const p = CE('div', `puck ${classifyDelay(r.delay_min)}`);

    // times inside puck: scheduled → ETA when available (your preference),
    // otherwise fall back to belt start → end.
    const showSched = (r.scheduled_local || r.eta_local);
    const timesText = showSched
      ? `${(r.scheduled_local||'').trim()} → ${(r.eta_local||'').trim()}`
      : `${hhmm(r.start)} → ${hhmm(r.end)}`;

    const title = CE('div','title');
    title.textContent = `${(r.flight||'').trim()} • ${(r.origin_iata||'').trim() || r.origin || ''}`.replace(/\s+/g,' ');
    const sub = CE('div','sub'); sub.textContent = timesText;

    const tipLines = [
      `${(r.flight||'').trim()} ${r.origin?`• ${r.origin}`:''}`,
      showSched ? timesText : `${hhmm(r.start)} → ${hhmm(r.end)}`,
      r.flow || '', r.airline || '', r.aircraft || '',
      r.reason ? `Reason: ${r.reason}` : ''
    ].filter(Boolean);
    p.setAttribute('data-tip', tipLines.join('\n'));

    p.appendChild(title); p.appendChild(sub);

    // position
    const left = xForDate(r.start || r.eta);
    const right = xForDate(r.end   || r.eta);
    p.style.left = `${left}px`;
    p.style.width = `${Math.max(120, right-left-4)}px`;
    p.style.top = `${r._lane * (getCss('--lane-height',58) + getCss('--lane-gap',10))}px`;

    // GREY if ended >2min ago
    const ended = +new Date(r.end || r.eta || 0);
    if(ended && ended < (Date.now() - 2*minute)){
      p.classList.add('past');
    }
    return p;
  }

  function getCss(name, fallback){
    const v = parseInt(getComputedStyle(document.documentElement).getPropertyValue(name),10);
    return Number.isFinite(v)?v:fallback;
  }

  function drawRows(){
    rowsHost.innerHTML='';
    const beltsToShow = BELTS.filter(b => beltFilter.size===0 || beltFilter.has(b));

    // build belt rows
    const frag = document.createDocumentFragment();
    let totalHeight = 0;
    const laneH = getCss('--lane-height',58);
    const laneGap = getCss('--lane-gap',10);
    const padY = getCss('--belt-pad-y',18);

    for(const b of beltsToShow){
      const row = CE('div','belt-row');
      const inner = CE('div','row-inner'); row.appendChild(inner);

      const items = mergedRows.filter(r => r.belt === b);
      const {lanes, items: packed} = packLanes(items);

      // row height fits all lanes, and pucks sit at the TOP because we pad-top the row
      const contentH = lanes * (laneH + laneGap) - laneGap;
      row.style.minHeight = `calc(${padY}px*2 + ${Math.max(contentH, laneH)}px)`;

      for(const r of packed) inner.appendChild(buildPuck(r));

      frag.appendChild(row);
      totalHeight += row.getBoundingClientRect().height;
    }
    rowsHost.appendChild(frag);

    // grid width
    const w = Math.max(xForDate(timeMax) + 200, scrollOuter.clientWidth);
    scrollInner.style.width = `${w}px`;

    drawGridlines(totalHeight);
    updateNowLine(totalHeight);
  }

  function drawGridlines(totalHeight){
    [...scrollInner.querySelectorAll('.gridline, .gridline-minor')].forEach(n=>n.remove());

    // hour and 10-min minor lines
    const start = new Date(timeMin); start.setMinutes(0,0,0);
    const endMs = +new Date(timeMax);

    const frag = document.createDocumentFragment();
    for(let t=+start; t<=endMs; t+=10*minute){
      const x = xForDate(t);
      const el = CE('div', (new Date(t).getMinutes()===0) ? 'gridline' : 'gridline-minor');
      el.style.left = `${x}px`;
      el.style.height = `${totalHeight}px`;
      frag.appendChild(el);
    }
    scrollInner.appendChild(frag);
  }

  function drawRuler(){
    const ctx = rulerCanvas.getContext('2d');
    const width = Math.max(xForDate(timeMax) + 200, scrollOuter.clientWidth);
    const height = 44;
    const dpr = window.devicePixelRatio || 1;

    rulerCanvas.width = Math.floor(width*dpr);
    rulerCanvas.height = Math.floor(height*dpr);
    rulerCanvas.style.width = `${width}px`;
    rulerCanvas.style.height = `${height}px`;
    ctx.setTransform(dpr,0,0,dpr,0,0);

    ctx.clearRect(0,0,width,height);
    ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--panel') || '#111b26';
    ctx.fillRect(0,0,width,height);

    // bottom border
    ctx.strokeStyle = '#1a2a3a'; ctx.beginPath(); ctx.moveTo(0,height-1); ctx.lineTo(width,height-1); ctx.stroke();

    // ticks & labels
    ctx.fillStyle = '#dce6f2';
    ctx.font = '14px ui-sans-serif, system-ui, Segoe UI, Roboto, Arial';
    ctx.textBaseline = 'alphabetic';

    const start = new Date(timeMin); start.setMinutes(0,0,0);
    for(let t=+start; t<=+timeMax; t+=60*minute){
      const x = Math.floor(xForDate(t));
      // tick column indicator (thin)
      ctx.fillStyle = '#213043'; ctx.fillRect(x, 0, 1, height);
      ctx.fillStyle = '#dce6f2'; ctx.fillText(hhmm(t), x+8, height-12);
    }
  }

  function updateNowLine(totalHeight){
    if(!nowLine) return;
    nowLine.style.left = `${xForDate(Date.now())}px`;
    nowLine.style.height = `${totalHeight}px`;
  }

  function drawAll(){
    drawRuler();
    drawRows();
  }

  // --------- interactions ----------
  zoomSel?.addEventListener('change', ()=>{
    pxPerMin = Math.max(8, parseFloat(zoomSel.value||'8'));
    drawAll();
  });
  nowBtn?.addEventListener('click', ()=>{
    const x = xForDate(Date.now());
    const vw = scrollOuter.clientWidth;
    scrollOuter.scrollLeft = Math.max(0, x - vw/2);
  });
  window.addEventListener('resize', drawAll);
  setInterval(()=>updateNowLine(rowsHost.getBoundingClientRect().height||0), 30*1000);

  // auto-refresh ~90s
  setInterval(()=>{
    fetch('assignments.json', {cache:'no-store'}).then(r=>r.json()).then(data=>{
      const prevGen = (liveRows && liveRows.generated_at_utc)||'';
      liveRows = Array.isArray(data.rows) ? data.rows : [];
      mergedRows = mergeWithHistory(liveRows);
      drawAll();
      if(meta) meta.textContent = `Generated ${data.generated_at_local || data.generated_at_utc || ''} • Horizon ${data.horizon_minutes || ''} min`;
    }).catch(()=>{});
  }, 90*1000);

  // boot
  load().then(()=>{
    // start centered on now
    const x = xForDate(Date.now());
    const vw = scrollOuter.clientWidth;
    scrollOuter.scrollLeft = Math.max(0, x - vw/2);
  });
})();
