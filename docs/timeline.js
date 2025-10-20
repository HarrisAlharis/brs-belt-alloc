/* BRS Timeline — robust, shows all flights, auto-centers on NOW, tolerant of missing fields */

(function(){
  const SCROLLER = document.getElementById('tl-scroller');
  const CANVAS   = document.getElementById('tl-canvas');
  const META     = document.getElementById('meta');
  const BTN_NOW  = document.getElementById('btn-now');
  const ZOOM_SEL = document.getElementById('zoom');

  // Layout constants
  let PX_PER_MIN = Number(ZOOM_SEL.value);       // user-controlled
  const BELT_ROWS = [1,2,3,5,6,7];               // fixed row order to display
  const ROW_H = 120;                             // row height
  const TOP_PAD = 28;                            // pad above first row
  const LEFT_PAD = 80;                           // space for belt labels
  const HOURS_BACK = 5;                          // show past 5h
  const HOURS_FWD  = 8;                          // and next 8h
  const START_DELAY_MIN = 15;                    // default if start absent
  const DWELL_MIN       = 30;

  function pad(n){ return String(n).padStart(2,'0'); }
  function hhmm(d){ return `${pad(d.getHours())}:${pad(d.getMinutes())}`; }
  function parseISO(s){ const d = new Date(s); return isNaN(d) ? null : d; }
  function addMin(d,m){ return new Date(d.getTime()+m*60000); }

  function beltY(belt){
    const idx = Math.max(0, BELT_ROWS.indexOf(Number(belt)));
    return TOP_PAD + idx*ROW_H;
  }

  function reasonColor(r){
    // Color by delay_min buckets if present; otherwise by status text
    if (typeof r.delay_min === 'number'){
      if (r.delay_min >= 20) return 'puck-red';
      if (r.delay_min >= 10) return 'puck-amber';
      if (r.delay_min <= -1) return 'puck-blue';
      return 'puck-ontime';
    }
    const s = (r.status||'').toLowerCase();
    if (s.includes('delayed')) return 'puck-amber';
    if (s.includes('estimated')) return 'puck-ontime';
    if (s.includes('early')) return 'puck-blue';
    return 'puck-ontime';
  }

  function buildWindow(rows){
    // Determine canvas time range: now - back … now + fwd, but
    // also include min/max from data to avoid clipping if all data is far away.
    const now = new Date();
    let minT = addMin(now, -HOURS_BACK*60);
    let maxT = addMin(now,  HOURS_FWD*60);

    for (const r of rows){
      const start = parseISO(r.start) || addMin(parseISO(r.eta)||now, START_DELAY_MIN);
      const end   = parseISO(r.end)   || addMin(start, DWELL_MIN);
      if (start && start < minT) minT = start;
      if (end   && end   > maxT) maxT = end;
    }
    return {minT, maxT, now};
  }

  function setCanvasSize(minT, maxT){
    const mins = Math.ceil((maxT - minT)/60000);
    const w = LEFT_PAD + Math.max(1200, mins * PX_PER_MIN) + 200;
    const h = TOP_PAD + BELT_ROWS.length*ROW_H + 60;
    CANVAS.style.width  = `${w}px`;
    CANVAS.style.height = `${h}px`;
    return {w,h, mins};
  }

  function clearCanvas(){ CANVAS.innerHTML = ''; }

  function addTick(x, label){
    const line = document.createElement('div');
    line.className = 'tick';
    line.style.left = `${x}px`;
    CANVAS.appendChild(line);

    const lb = document.createElement('div');
    lb.className = 'tick-label';
    lb.textContent = label;
    lb.style.left = `${x+4}px`;
    CANVAS.appendChild(lb);
  }

  function renderGrid(minT, maxT){
    // Belt stripes + labels
    for (let i=0;i<BELT_ROWS.length;i++){
      const y = TOP_PAD + i*ROW_H;
      const stripe = document.createElement('div');
      stripe.className = 'belt-stripe';
      stripe.style.top = `${y}px`;
      stripe.style.height = `${ROW_H}px`;
      CANVAS.appendChild(stripe);

      const name = document.createElement('div');
      name.className = 'belt-name';
      name.textContent = `Belt ${BELT_ROWS[i]}`;
      name.style.top = `${y+6}px`;
      name.style.left = '8px';
      CANVAS.appendChild(name);
    }

    // Minute ticks every 15 min
    const totalMin = Math.ceil((maxT - minT)/60000);
    for (let m=0; m<=totalMin; m+=15){
      const x = LEFT_PAD + m*PX_PER_MIN;
      const t = addMin(minT, m);
      const label = (m % 60 === 0) ? `${pad(t.getHours())}:${pad(t.getMinutes())}` : '';
      addTick(x, label);
    }
  }

  function renderNow(minT, now){
    const x = LEFT_PAD + Math.max(0, (now - minT)/60000) * PX_PER_MIN;
    const nl = document.createElement('div');
    nl.className = 'tl-now-line';
    nl.style.left = `${x}px`;
    CANVAS.appendChild(nl);
    return x;
  }

  function textFor(r){
    const f = (r.flight && r.flight.trim()) ? r.flight.trim() : '—';
    const origin = (r.origin_iata || (r.origin||'')).replace(/[()]/g,'').trim();
    return `${f} • ${origin || ''}`.trim();
  }

  function ensureComputedTimes(r){
    const eta = parseISO(r.eta) || null;
    const start = parseISO(r.start) || (eta ? addMin(eta, START_DELAY_MIN) : null);
    const end   = parseISO(r.end)   || (start ? addMin(start, DWELL_MIN) : null);
    return {eta, start, end};
  }

  function renderPucks(rows, minT){
    for (const r of rows){
      if (!r.belt) continue;
      const { start, end } = ensureComputedTimes(r);
      if (!start || !end) continue;

      const x1 = LEFT_PAD + ((start - minT)/60000) * PX_PER_MIN;
      const x2 = LEFT_PAD + ((end   - minT)/60000) * PX_PER_MIN;
      const y  = beltY(r.belt) + 26;

      const el = document.createElement('div');
      el.className = `puck ${reasonColor(r)}`;
      el.style.left = `${Math.max(LEFT_PAD, x1)}px`;
      el.style.top  = `${y}px`;
      el.style.width = `${Math.max(90, (x2-x1))}px`;
      el.title = [
        `Flight: ${r.flight || '—'}`,
        `Origin: ${r.origin_iata || r.origin || '—'}`,
        `ETA: ${r.eta_local || (r.eta ? hhmm(new Date(r.eta)) : '—')}`,
        `Start: ${start ? hhmm(start):'—'} • End: ${end ? hhmm(end):'—'}`,
        `Belt: ${r.belt} • Flow: ${r.flow || '—'}`,
        `Status: ${r.status || '—'}`,
        `Reason: ${r.reason || '—'}`
      ].join('\n');

      el.textContent = textFor(r);
      CANVAS.appendChild(el);
    }
  }

  function updateMeta(data){
    META.textContent = `Generated ${data.generated_at_local || data.generated_at_utc || ''} • Horizon ${data.horizon_minutes || ''} min`;
  }

  function scrollToX(x){
    const viewW = SCROLLER.clientWidth;
    const target = Math.max(0, x - viewW*0.33);
    SCROLLER.scrollTo({left: target, behavior: 'smooth'});
  }

  function applyFilters(){
    const active = [...document.querySelectorAll('.chip[data-belt].active')]
                   .map(b => Number(b.dataset.belt));
    const pucks = CANVAS.querySelectorAll('.puck');
    if (active.length === 0){
      pucks.forEach(p => p.style.display = 'none');
    } else {
      pucks.forEach(p => {
        // read belt from title
        const m = p.title.match(/Belt:\s(\d+)/);
        const belt = m ? Number(m[1]) : null;
        p.style.display = (!belt || active.includes(belt)) ? '' : 'none';
      });
    }
  }

  async function init(){
    // Fetch JSON (cache-bust)
    const res = await fetch(`assignments.json?v=${Date.now()}`);
    const data = await res.json();
    updateMeta(data);

    const rows = Array.isArray(data.rows) ? data.rows : [];

    // Build time window and canvas
    const {minT, maxT, now} = buildWindow(rows);
    clearCanvas();
    setCanvasSize(minT, maxT);
    renderGrid(minT, maxT);
    const nowX = renderNow(minT, now);
    renderPucks(rows, minT);
    scrollToX(nowX);

    // Belt filter buttons
    document.querySelectorAll('.chip[data-belt]').forEach(btn=>{
      btn.addEventListener('click', ()=>{
        btn.classList.toggle('active');
        applyFilters();
      });
    });
    document.getElementById('filter-all').addEventListener('click', ()=>{
      document.querySelectorAll('.chip[data-belt]').forEach(b=>b.classList.add('active'));
      applyFilters();
    });
    document.getElementById('filter-none').addEventListener('click', ()=>{
      document.querySelectorAll('.chip[data-belt]').forEach(b=>b.classList.remove('active'));
      applyFilters();
    });

    // Zoom
    ZOOM_SEL.addEventListener('change', ()=>{
      PX_PER_MIN = Number(ZOOM_SEL.value);
      // re-draw with same data
      clearCanvas();
      setCanvasSize(minT, maxT);
      renderGrid(minT, maxT);
      const nx = renderNow(minT, new Date());
      renderPucks(rows, minT);
      applyFilters();
      scrollToX(nx);
    });

    // “Now” button
    BTN_NOW.addEventListener('click', ()=>{
      const nx = LEFT_PAD + Math.max(0, (new Date() - minT)/60000) * PX_PER_MIN;
      scrollToX(nx);
    });

    // Drag to pan
    let dragging = false, startX=0, startScroll=0;
    SCROLLER.addEventListener('mousedown', e=>{
      dragging = true; startX = e.clientX; startScroll = SCROLLER.scrollLeft;
      SCROLLER.classList.add('grabbing');
    });
    window.addEventListener('mousemove', e=>{
      if (!dragging) return;
      const dx = e.clientX - startX;
      SCROLLER.scrollLeft = startScroll - dx;
    });
    window.addEventListener('mouseup', ()=>{
      dragging = false; SCROLLER.classList.remove('grabbing');
    });

    // Auto-refresh when JSON changes (lightweight poll)
    setInterval(async ()=>{
      try{
        const r2 = await fetch(`assignments.json?v=${Date.now()}`);
        const d2 = await r2.json();
        if ((d2.generated_at_utc||'') !== (data.generated_at_utc||'')){
          location.reload();
        }
      }catch(e){}
    }, 60000);
  }

  init().catch(err=>{
    META.textContent = `Error: ${err?.message||err}`;
    console.error(err);
  });
})();
