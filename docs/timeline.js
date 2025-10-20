/* Restored original row structure + requested features only:
   - pucks top-aligned within each belt row
   - 10-min minor grid lines
   - keep 4h history in localStorage; grey pucks when (end < now-2min)
   - min zoom 8px/min
   - belts always shown for 1,2,3,5,6,7
*/
(function(){
  const $ = s => document.querySelector(s);
  const CE = (t,c)=>{const n=document.createElement(t); if(c) n.className=c; return n;};
  const minute = 60*1000;

  const zoomSel = $('#zoom');
  const nowBtn  = $('#nowBtn');
  const meta    = $('#meta');

  const scrollOuter = $('#scrollOuter');
  const scrollInner = $('#scrollInner');
  const rowsHost    = $('#rows');
  const rulerCanvas = /** @type {HTMLCanvasElement} */($('#ruler'));
  const nowLine     = $('#nowLine');
  const beltChips   = $('#beltChips');

  const BELTS = [1,2,3,5,6,7];
  let pxPerMin = Math.max(8, parseFloat(zoomSel?.value || '8'));
  let timeMin=null, timeMax=null;
  let beltFilter = new Set();
  let liveRows = [];
  let mergedRows = [];

  const getCss = (name, fallback)=>{
    const v = parseInt(getComputedStyle(document.documentElement).getPropertyValue(name),10);
    return Number.isFinite(v)?v:fallback;
  };
  const laneH   = ()=>getCss('--lane-height',58);
  const laneGap = ()=>getCss('--lane-gap',10);
  const padY    = ()=>getCss('--belt-pad-y',18);

  const xForDate = d => ((+new Date(d))-(+timeMin))/60000*pxPerMin;
  const hhmm = d => { const x=new Date(d); return `${String(x.getHours()).padStart(2,'0')}:${String(x.getMinutes()).padStart(2,'0')}`; };

  // ---------- History (4h) ----------
  const HIST_KEY='brs_belt_history_v1';
  const loadHist = ()=>{ try{ return JSON.parse(localStorage.getItem(HIST_KEY)||'[]'); }catch{return [];} };
  const saveHist = arr=>{ try{ localStorage.setItem(HIST_KEY, JSON.stringify(arr)); }catch{} };
  function mergeWithHistory(rows){
    const now=Date.now(), cutoff=now-4*60*minute;
    const hist = loadHist().filter(r => +new Date(r.end||r.eta||0) >= cutoff);
    const all = [...rows, ...hist];
    const map = new Map();
    for(const r of all){
      const key = `${r.flight||''}|${r.start||r.eta||''}|${r.belt||''}`;
      if(!map.has(key) || rows.includes(r)) map.set(key,r);
    }
    const merged=[...map.values()];
    saveHist(merged.filter(r => +new Date(r.end||r.eta||0) >= cutoff));
    return merged;
  }

  // ---------- Data load ----------
  function fetchJSON(u){ return fetch(u, {cache:'no-store'}).then(r=>r.json()); }
  function load(){
    return fetchJSON('assignments.json?v='+Date.now()).then(data=>{
      liveRows = Array.isArray(data.rows)?data.rows:[];
      mergedRows = mergeWithHistory(liveRows);

      const now = Date.now(), pad=45*minute;
      if(mergedRows.length){
        const starts = mergedRows.map(r=>+new Date(r.start||r.eta));
        const ends   = mergedRows.map(r=>+new Date(r.end  ||r.eta));
        timeMin = new Date(Math.min(Math.min(...starts)-pad, now-4*60*minute));
        timeMax = new Date(Math.max(...ends)+pad);
      }else{
        timeMin = new Date(now-4*60*minute);
        timeMax = new Date(now+90*minute);
      }

      if(meta) meta.textContent = `Generated ${data.generated_at_local || data.generated_at_utc || ''} • Horizon ${data.horizon_minutes || ''} min`;
      buildBeltChips();
      drawAll();
    });
  }

  // ---------- UI chips ----------
  function buildBeltChips(){
    beltChips.innerHTML='';
    const frag=document.createDocumentFragment();
    const mk=(label,key)=>{ const b=CE('button','chip'); b.textContent=label; b.dataset.key=key; b.addEventListener('click',()=>toggleFilter(key)); frag.appendChild(b); };
    BELTS.forEach(n=>mk(`Belt ${n}`,String(n)));
    mk('All','all'); mk('None','none');
    beltChips.appendChild(frag);
    syncChipUI();
  }
  function toggleFilter(key){
    if(key==='all'){ beltFilter.clear(); }
    else if(key==='none'){ beltFilter=new Set(['__none__']); }
    else{
      const n=parseInt(key,10);
      if(Number.isFinite(n)){ if(beltFilter.has(n)) beltFilter.delete(n); else beltFilter.add(n); }
    }
    syncChipUI(); drawAll();
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

  // ---------- Packing ----------
  function packLanes(items){
    const sorted=items.slice().sort((a,b)=>+new Date(a.start)-+new Date(b.start));
    const lanes=[]; // lastEnd per lane
    for(const f of sorted){
      const s=+new Date(f.start), e=+new Date(f.end);
      let lane=-1;
      for(let i=0;i<lanes.length;i++){ if(s>=lanes[i]){ lane=i; break; } }
      if(lane===-1){ lane=lanes.length; lanes.push(e); } else { lanes[lane]=e; }
      f._lane=lane;
    }
    return {lanes: Math.max(1, lanes.length), items: sorted};
  }

  function delayClass(d){
    if(d==null) return 'ok';
    if(d>=20) return 'late';
    if(d>=10) return 'mid';
    if(d<=-1) return 'early';
    return 'ok';
  }

  function buildPuck(f){
    const p=CE('div',`puck ${delayClass(f.delay_min)}`);

    const showSched = (f.scheduled_local || f.eta_local);
    const timesText = showSched ? `${(f.scheduled_local||'').trim()} → ${(f.eta_local||'').trim()}` : `${hhmm(f.start)} → ${hhmm(f.end)}`;

    const title=CE('div','title'); title.textContent = `${(f.flight||'').trim()} • ${(f.origin_iata||'').trim() || f.origin || ''}`.replace(/\s+/g,' ');
    const sub  =CE('div','sub');   sub.textContent   = timesText;
    p.appendChild(title); p.appendChild(sub);

    const tipLines=[`${(f.flight||'').trim()} ${f.origin?`• ${f.origin}`:''}`, timesText, f.flow||'', f.airline||'', f.aircraft||'', f.reason?`Reason: ${f.reason}`:''].filter(Boolean);
    p.setAttribute('data-tip', tipLines.join('\n'));

    const left=xForDate(f.start||f.eta), right=xForDate(f.end||f.eta);
    p.style.left=`${left}px`; p.style.width=`${Math.max(120,right-left-4)}px`;
    p.style.top =`${f._lane * (laneH()+laneGap())}px`;

    const ended=+new Date(f.end||f.eta||0);
    if(ended && ended < (Date.now()-2*minute)) p.classList.add('past');

    return p;
  }

  // ---------- Draw ----------
  function drawRows(){
    rowsHost.innerHTML='';
    const beltsToShow = BELTS.filter(b=>beltFilter.size===0 || beltFilter.has(b));
    const frag=document.createDocumentFragment();
    let totalHeight=0;

    for(const b of beltsToShow){
      const row = CE('div','belt-row');
      const name=CE('div','belt-name'); name.textContent=`Belt ${b}`;
      const inner=CE('div','row-inner');
      row.appendChild(name); row.appendChild(inner);

      const items=mergedRows.filter(r=>r.belt===b);
      const {lanes, items:packed}=packLanes(items);

      const contentH = lanes*(laneH()+laneGap()) - laneGap();
      row.style.minHeight = `calc(${padY()}px*2 + ${Math.max(contentH, laneH())}px)`;

      for(const f of packed) inner.appendChild(buildPuck(f));

      frag.appendChild(row);
      totalHeight += row.getBoundingClientRect().height;
    }
    rowsHost.appendChild(frag);

    const w = Math.max(xForDate(timeMax)+200, scrollOuter.clientWidth);
    scrollInner.style.width = `${w}px`;

    drawGridlines(totalHeight);
    updateNowLine(totalHeight);
  }

  function drawGridlines(totalHeight){
    [...scrollInner.querySelectorAll('.gridline,.gridline-minor')].forEach(n=>n.remove());
    const start=new Date(timeMin); start.setMinutes(0,0,0);
    const endMs=+new Date(timeMax);
    const frag=document.createDocumentFragment();
    for(let t=+start;t<=endMs;t+=10*minute){
      const x=xForDate(t);
      const isHour=(new Date(t).getMinutes()===0);
      const el=CE('div', isHour?'gridline':'gridline-minor');
      el.style.left=`${x}px`; el.style.height=`${totalHeight}px`; frag.appendChild(el);
    }
    scrollInner.appendChild(frag);
  }

  function drawRuler(){
    const ctx=rulerCanvas.getContext('2d');
    const width=Math.max(xForDate(timeMax)+200, scrollOuter.clientWidth);
    const height=44; const dpr=window.devicePixelRatio||1;
    rulerCanvas.width=Math.floor(width*dpr); rulerCanvas.height=Math.floor(height*dpr);
    rulerCanvas.style.width=`${width}px`; rulerCanvas.style.height=`${height}px`;
    ctx.setTransform(dpr,0,0,dpr,0,0);
    ctx.clearRect(0,0,width,height);
    ctx.fillStyle=getComputedStyle(document.documentElement).getPropertyValue('--panel')||'#111b26';
    ctx.fillRect(0,0,width,height);
    ctx.strokeStyle='#1a2a3a'; ctx.beginPath(); ctx.moveTo(0,height-1); ctx.lineTo(width,height-1); ctx.stroke();

    ctx.fillStyle='#dce6f2'; ctx.font='14px ui-sans-serif, system-ui, Segoe UI, Roboto, Arial'; ctx.textBaseline='alphabetic';
    const start=new Date(timeMin); start.setMinutes(0,0,0);
    for(let t=+start;t<=+timeMax;t+=60*minute){
      const x=Math.floor(xForDate(t));
      ctx.fillStyle='#213043'; ctx.fillRect(x,0,1,height);
      ctx.fillStyle='#dce6f2'; ctx.fillText(hhmm(t), x+8, height-12);
    }
  }

  function updateNowLine(totalHeight){
    if(!nowLine) return;
    nowLine.style.left=`${xForDate(Date.now())}px`;
    nowLine.style.height=`${totalHeight}px`;
  }

  function drawAll(){ drawRuler(); drawRows(); }

  // ---------- Interactions ----------
  zoomSel?.addEventListener('change', ()=>{ pxPerMin=Math.max(8,parseFloat(zoomSel.value||'8')); drawAll(); });
  nowBtn?.addEventListener('click', ()=>{
    const x=xForDate(Date.now()); const vw=scrollOuter.clientWidth;
    scrollOuter.scrollLeft=Math.max(0, x - vw/2);
  });
  window.addEventListener('resize', drawAll);
  setInterval(()=>updateNowLine(rowsHost.getBoundingClientRect().height||0), 30*1000);

  // auto refresh
  setInterval(()=>{
    fetch('assignments.json',{cache:'no-store'}).then(r=>r.json()).then(data=>{
      liveRows = Array.isArray(data.rows)?data.rows:[]; mergedRows=mergeWithHistory(liveRows);
      drawAll();
      if(meta) meta.textContent = `Generated ${data.generated_at_local || data.generated_at_utc || ''} • Horizon ${data.horizon_minutes || ''} min`;
    }).catch(()=>{});
  }, 90*1000);

  // boot
  load().then(()=>{
    const x=xForDate(Date.now()); const vw=scrollOuter.clientWidth;
    scrollOuter.scrollLeft=Math.max(0, x - vw/2);
  });
})();
