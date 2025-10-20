/* docs/timeline.js
 * Changes you asked for:
 * - MIN_SEP = 1 minute (lane reuse if next start ≥ lastEnd + 1 min)
 * - Puck title shows Flight • DEST again
 */

(function(){
  const $ = s => document.querySelector(s);
  const CE = (t,c)=>{ const n=document.createElement(t); if(c) n.className=c; return n; };

  const beltChips = $('#beltChips');
  const zoomSel   = $('#zoom');
  const nowBtn    = $('#nowBtn');
  const meta      = $('#meta');

  const beltsCol    = $('#beltsCol');
  const scrollOuter = $('#scrollOuter');
  const scrollInner = $('#scrollInner');
  const rowsHost    = $('#rows');
  const canvasRuler = /** @type {HTMLCanvasElement} */($('#ruler'));
  const nowLine     = $('#nowLine');

  const BELTS_ORDER = [1,2,3,5,6,7];
  const minute = 60*1000;

  // 1 minute separation to reuse a lane
  const MIN_SEP = 1 * minute;

  const cssNum = (name, fb)=>{
    const v = parseInt(getComputedStyle(document.documentElement).getPropertyValue(name),10);
    return Number.isFinite(v) ? v : fb;
  };
  const LANE_H   = cssNum('--lane-height',58);
  const LANE_GAP = cssNum('--lane-gap',10);
  const BELT_PAD = cssNum('--belt-pad-y',14);

  let pxPerMin = parseFloat(zoomSel?.value || '6');
  let assignments=null, flights=[], beltFilter=new Set();
  let timeMin=null, timeMax=null;

  const dFmt = d => {
    const dt = new Date(d);
    return `${String(dt.getHours()).padStart(2,'0')}:${String(dt.getMinutes()).padStart(2,'0')}`;
  };
  const xFor = d => ((+new Date(d))-(+timeMin))/60000*pxPerMin;
  const fetchJSON = u => fetch(u,{cache:'no-store'}).then(r=>r.json());

  function load(){
    return fetchJSON('assignments.json').then(data=>{
      assignments=data; flights=(data.rows||[]).slice();

      if (flights.length){
        const s = flights.map(r=>+new Date(r.start||r.eta));
        const e = flights.map(r=>+new Date(r.end  ||r.eta));
        const pad=60*minute;
        timeMin = new Date(Math.min(...s)-pad);
        timeMax = new Date(Math.max(...e)+pad);
      }else{
        const now=Date.now();
        timeMin=new Date(now-90*minute);
        timeMax=new Date(now+90*minute);
      }

      if (meta) meta.textContent = `Generated ${assignments.generated_at_local} • Horizon ${assignments.horizon_minutes} min`;
      buildChips();
      drawAll(true);
    });
  }

  function buildChips(){
    if (!beltChips) return;
    beltChips.innerHTML='';
    const f=document.createDocumentFragment();
    const mk=(label,key)=>{
      const b=CE('button','chip'); b.textContent=label; b.dataset.key=key;
      b.addEventListener('click',()=>toggleFilter(key)); f.appendChild(b);
    };
    BELTS_ORDER.forEach(n=>mk(`Belt ${n}`,String(n)));
    mk('All','all'); mk('None','none');
    updateChipVisuals(); beltChips.appendChild(f);
  }
  function toggleFilter(key){
    if(key==='all') beltFilter.clear();
    else if(key==='none') beltFilter=new Set(['__none__']);
    else{
      const n=parseInt(key,10);
      if(Number.isFinite(n)){ if(beltFilter.has(n)) beltFilter.delete(n); else beltFilter.add(n); }
    }
    updateChipVisuals(); drawAll(false);
  }
  function updateChipVisuals(){
    [...beltChips.querySelectorAll('.chip')].forEach(c=>{
      const k=c.dataset.key;
      const on=(k==='all'&&beltFilter.size===0)||
               (k==='none'&&beltFilter.has('__none__'))||
               (/^\d+$/.test(k)&&beltFilter.has(parseInt(k,10)));
      c.classList.toggle('on',on);
    });
  }

  function packLanes(items){
    const sorted=items.slice().sort((a,b)=>+new Date(a.start)-+new Date(b.start));
    const ends=[];
    for(const f of sorted){
      const s=+new Date(f.start), e=+new Date(f.end);
      let lane=-1;
      for(let i=0;i<ends.length;i++){ if(s>=ends[i]+MIN_SEP){ lane=i; break; } }
      if(lane===-1){ lane=ends.length; ends.push(e); } else { ends[lane]=e; }
      f._lane=lane;
    }
    return {lanes:Math.max(1,ends.length), items:sorted};
  }

  function delayClass(d){
    if(d==null) return 'ok';
    if(d>=20) return 'late';
    if(d>=10) return 'mid';
    if(d<=-1) return 'early';
    return 'ok';
  }
  const schedEta = f => {
    const s=f.scheduled_local||'', e=f.eta_local||(f.eta?dFmt(f.eta):'');
    if(s&&e) return `${s} → ${e}`;
    return e||s||'';
  };

  function buildPuck(f){
    const p=CE('div',`puck ${delayClass(f.delay_min)}`);

    // Title shows: FLIGHT • DEST
    const dest = ((f.origin_iata||'').trim() || (f.origin||'')).toString();
    const title=CE('div','title');
    title.textContent = `${(f.flight||'').trim()} • ${dest}`.replace(/\s+/g,' ');
    const sub=CE('div','sub'); sub.textContent = schedEta(f);

    // Tooltip (unchanged)
    const tip=[`${(f.flight||'').trim()} ${f.origin?`• ${f.origin}`:''}`, schedEta(f), f.flow, f.airline, f.aircraft, f.reason?`Reason: ${f.reason}`:'']
      .filter(Boolean).join('\n');
    p.setAttribute('data-tip', tip);

    p.appendChild(title); p.appendChild(sub);

    const x1=xFor(f.start), x2=xFor(f.end);
    p.style.left=`${x1}px`;
    p.style.width=`${Math.max(180, x2-x1-4)}px`;
    p.style.top=`${f._lane*(cssNum('--lane-height',58)+cssNum('--lane-gap',10))}px`;
    return p;
  }

  function drawRowsAndBelts(){
    rowsHost.innerHTML=''; beltsCol.innerHTML='';
    const show = BELTS_ORDER.filter(b=>beltFilter.size===0||beltFilter.has(b));

    const fragRows=document.createDocumentFragment();
    const fragBelts=document.createDocumentFragment();
    let totalH=0;

    for(const b of show){
      const row=CE('div','row');
      const items=flights.filter(r=>r.belt===b);
      const {lanes, items:packed}=packLanes(items);

      const contentH = lanes*LANE_H + Math.max(0, lanes-1)*LANE_GAP;
      const rowH = (BELT_PAD*2) + contentH;
      row.style.height = `${rowH}px`;
      for(const f of packed) row.appendChild(buildPuck(f));
      fragRows.appendChild(row);

      const lab=CE('div','belt-label'); lab.textContent=`Belt ${b}`;
      lab.style.height=`${rowH}px`;
      fragBelts.appendChild(lab);

      totalH += rowH;
    }
    rowsHost.appendChild(fragRows);
    beltsCol.appendChild(fragBelts);

    const contentW = Math.max(xFor(timeMax)+200, scrollOuter.clientWidth);
    scrollInner.style.width = `${contentW}px`;
    drawGridlines(totalH);
    updateNowLine(totalH);
  }

  function drawGridlines(totalH){
    [...scrollInner.querySelectorAll('.gridline')].forEach(x=>x.remove());
    const start=new Date(timeMin); start.setMinutes(0,0,0);
    const endMs=+new Date(timeMax);
    const frag=document.createDocumentFragment();
    for(let t=+start; t<=endMs; t+=10*minute){
      const x=Math.floor(xFor(t));
      const major = ((t-(+start))%(60*minute))===0;
      const gl=CE('div', 'gridline'+(major?'':' minor'));
      gl.style.left=`${x}px`; gl.style.height=`${totalH}px`;
      frag.appendChild(gl);
    }
    scrollInner.appendChild(frag);
    drawRuler();
  }

  function drawRuler(){
    const ctx=canvasRuler.getContext('2d');
    const width=Math.max(xFor(timeMax)+200, scrollOuter.clientWidth);
    const height=44, dpr=window.devicePixelRatio||1;
    canvasRuler.width=Math.floor(width*dpr);
    canvasRuler.height=Math.floor(height*dpr);
    canvasRuler.style.width=`${width}px`;
    canvasRuler.style.height=`${height}px`;
    ctx.setTransform(dpr,0,0,dpr,0,0);
    ctx.clearRect(0,0,width,height);
    ctx.fillStyle=getComputedStyle(document.documentElement).getPropertyValue('--panel')||'#111b26';
    ctx.fillRect(0,0,width,height);
    ctx.strokeStyle='#1a2a3a'; ctx.beginPath(); ctx.moveTo(0,height-1); ctx.lineTo(width,height-1); ctx.stroke();
    const start=new Date(timeMin); start.setMinutes(0,0,0);
    for(let t=+start; t<=+timeMax; t+=60*minute){
      const x=Math.floor(xFor(t));
      ctx.fillStyle='#213043'; ctx.fillRect(x,0,1,height);
      ctx.fillStyle='#dce6f2'; ctx.font='14px ui-sans-serif, system-ui, Segoe UI, Roboto, Arial';
      ctx.textBaseline='alphabetic'; ctx.fillText(dFmt(t), x+8, height-12);
    }
  }

  function updateNowLine(totalH){
    nowLine.style.left=`${xFor(Date.now())}px`;
    nowLine.style.height=`${totalH}px`;
  }

  function drawAll(reset){
    drawRowsAndBelts();
    if(reset){
      const nowX=xFor(Date.now()), viewW=scrollOuter.clientWidth;
      scrollOuter.scrollLeft=Math.max(0, nowX - viewW/2);
    }
  }

  zoomSel?.addEventListener('change', ()=>{ pxPerMin=parseFloat(zoomSel.value||'6'); drawAll(false); });
  nowBtn?.addEventListener('click', ()=>{
    const nowX=xFor(Date.now()), viewW=scrollOuter.clientWidth;
    scrollOuter.scrollLeft=Math.max(0, nowX - viewW/2);
  });

  // keep left labels vertically synced with the scroll
  scrollOuter.addEventListener('scroll', ()=>{ beltsCol.scrollTop = scrollOuter.scrollTop; });

  window.addEventListener('resize', ()=>drawAll(false));
  setInterval(()=>updateNowLine(rowsHost.getBoundingClientRect().height||0), 30*1000);

  setInterval(()=>{
    fetch('assignments.json',{cache:'no-store'}).then(r=>r.json()).then(data=>{
      const prev=assignments?.generated_at_utc;
      assignments=data; flights=(data.rows||[]).slice();
      if(data.generated_at_utc!==prev) load(); else drawAll(false);
    }).catch(()=>{});
  }, 90*1000);

  load();
})();
