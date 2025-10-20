(() => {
  const state = {
    pxPerMin: 6,                 // default zoom
    windowMinsBack: 60,          // how far left of "now" the grid starts
    windowMinsAhead: 180,        // horizon
    belts: [1,2,3,5,6,7],
    rowsEl: null, yAxisEl: null, xAxisEl: null, nowEl: null,
    lastDataStamp: "",
    timer: null
  };

  const $ = sel => document.querySelector(sel);
  const fmtHM = d => d.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
  const addMin = (d, m) => new Date(d.getTime() + m*60000);

  function showError(msg){
    const b = $('#errorBanner');
    b.textContent = msg;
    b.classList.remove('hidden');
  }
  function hideError(){ $('#errorBanner').classList.add('hidden'); }

  function classify(row){
    // choose puck color class by delay_min
    const dm = typeof row.delay_min === 'number' ? row.delay_min : 0;
    if (dm >= 20) return 'd20';
    if (dm >= 10) return 'd10';
    if (dm <= -1)  return 'early';
    return 'on';
  }

  function buildAxes(now){
    const start = addMin(now, -state.windowMinsBack);
    const end   = addMin(now,  state.windowMinsAhead);
    const totalMin = Math.round((end - start)/60000);

    // X ticks each hour
    state.xAxisEl.innerHTML = '';
    const hours = Math.ceil(totalMin/60)+1;
    for(let i=0;i<hours;i++){
      const t = addMin(start, i*60);
      const div = document.createElement('div');
      div.className = 'x-tick';
      div.style.position='absolute';
      div.style.left = `${i*60*state.pxPerMin + 8}px`;
      div.textContent = fmtHM(t);
      state.xAxisEl.appendChild(div);
    }
    // width keeper (so scroll area has width)
    state.rowsEl.style.width = `${totalMin*state.pxPerMin + 200}px`;

    // Y axis
    state.yAxisEl.innerHTML = '';
    state.belts.forEach(b=>{
      const div = document.createElement('div');
      div.className = 'belt';
      div.textContent = `Belt ${b}`;
      state.yAxisEl.appendChild(div);
    });
  }

  function clearRows(){
    state.rowsEl.innerHTML = '';
    state.belts.forEach(()=> {
      const r = document.createElement('div');
      r.className = 'row';
      state.rowsEl.appendChild(r);
    });
  }

  function leftForTime(now, date){
    const start = addMin(now, -state.windowMinsBack);
    const mins  = (date - start)/60000;
    return Math.round(mins*state.pxPerMin);
  }

  function placePuck(now, row){
    // Guard input
    if (!row || !row.eta || !row.start || !row.end) return;
    const eta   = new Date(row.eta);
    const start = new Date(row.start);
    const end   = new Date(row.end);

    if (!(eta instanceof Date) || isNaN(eta)) return;
    if (!(start instanceof Date) || isNaN(start)) return;
    if (!(end instanceof Date) || isNaN(end)) return;

    const left = leftForTime(now, start);
    const right = leftForTime(now, end);
    const width = Math.max(40, right - left); // prevent negative/too small

    const beltIdx = Math.max(0, state.belts.indexOf(row.belt));
    const rowTop = beltIdx * parseInt(getComputedStyle(document.documentElement).getPropertyValue('--row-h'));

    const puck = document.createElement('div');
    puck.className = `puck ${classify(row)} ${row.ui_age_min <= -60 ? 'old':''}`;
    puck.style.left = `${left + 16}px`; // lane padding
    puck.style.top  = `${rowTop + 18}px`;
    puck.style.width = `${width - 32}px`;

    const title = `${row.flight || ''} • ${row.origin_iata || row.origin || ''}`.trim();
    const sub   = `${(row.scheduled_local||'').padStart(4,'0')} → ${(row.eta_local||'').padStart(4,'0')}`;

    puck.innerHTML = `<div class="title">${title}</div><div class="sub">${sub}</div>`;
    puck.title = [
      `${row.flight || ''}  ${row.origin || ''}`,
      `Scheduled: ${row.scheduled_local || '?'}`,
      `ETA: ${row.eta_local || '?'}`,
      `Belt: ${row.belt || '?'}`,
      `Reason: ${row.reason || ''}`,
      `Status: ${row.status || ''}`
    ].join('\n');

    state.rowsEl.appendChild(puck);
  }

  async function loadData(){
    // Cache buster tied to minute to avoid overfetch
    const bust = new Date().toISOString().slice(0,16).replace(/[-:T]/g,'');
    const url = `assignments.json?cb=${bust}`;

    let data;
    try{
      const res = await fetch(url, {cache:'no-store'});
      if (!res.ok){
        showError(`Failed to fetch assignments.json (${res.status})`);
        return null;
      }
      const txt = await res.text();
      try{
        data = JSON.parse(txt);
      }catch(e){
        showError(`assignments.json parse error: ${e.message.slice(0,120)}`);
        return null;
      }
    }catch(err){
      showError(`Network error: ${String(err).slice(0,120)}`);
      return null;
    }
    hideError();
    return data;
  }

  function render(data){
    const now = new Date();
    $('#generated').textContent =
      `Generated ${data.generated_at_local || ''} • Horizon ${data.horizon_minutes||0} min`;

    buildAxes(now);
    clearRows();

    // Position now line
    const left = leftForTime(now, now);
    state.nowEl.style.left = `${left}px`;

    const rows = Array.isArray(data.rows) ? data.rows : [];
    // sort per ETA just to be safe
    rows.sort((a,b)=> new Date(a.eta) - new Date(b.eta));

    for (const r of rows){
      try{
        placePuck(now, r);
      }catch(e){
        // skip bad row but keep rendering the rest
        console.warn('Row render error', r, e);
      }
    }
  }

  async function tick(){
    const data = await loadData();
    if (!data) return;
    // avoid re-render if nothing changed
    const stamp = data.generated_at_utc || '';
    if (stamp === state.lastDataStamp){
      // still update now-line so it keeps sliding
      const now = new Date();
      const left = leftForTime(now, now);
      state.nowEl.style.left = `${left}px`;
      return;
    }
    state.lastDataStamp = stamp;
    render(data);
  }

  function init(){
    state.rowsEl = $('#rows');
    state.yAxisEl = $('#yAxis');
    state.xAxisEl = $('#xAxis');
    state.nowEl = $('#nowLine');

    // Build static y-axis rows container to match belts
    state.yAxisEl.style.minWidth = '120px';
    $('.gantt-scroll').addEventListener('scroll', (e)=>{
      // keep the x-axis and now-line in sync horizontally
      const x = e.target.scrollLeft;
      state.xAxisEl.style.transform = `translateX(${-x}px)`;
      state.nowEl.style.transform = `translateX(${-x}px)`;
    });

    $('#zoomSelect').addEventListener('change', (e)=>{
      state.pxPerMin = parseInt(e.target.value,10) || 6;
      // force full redraw
      state.lastDataStamp = '';
      tick();
    });
    $('#nowBtn').addEventListener('click', ()=>{
      const sc = document.querySelector('.gantt-scroll');
      const nowLeft = leftForTime(new Date(), new Date());
      sc.scrollLeft = Math.max(0, nowLeft - sc.clientWidth*0.25);
    });

    // first paint
    tick();
    // refresh roughly every 90s
    state.timer = setInterval(tick, 90000);
  }

  // Bootstrap
  window.addEventListener('DOMContentLoaded', init);
})();
