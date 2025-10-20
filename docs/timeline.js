(() => {
  // ------- CONFIG -------
  const HISTORY_HOURS = 4;                 // keep 4h of past flights
  const FADE_AFTER_MIN = 60;               // fade after 60 min in the past
  const DEFAULT_AHEAD_HOURS = 3;           // render forward window
  const BELTS = [1,2,3,5,6,7];             // lanes to show
  const LS_KEY = 'brs_timeline_history_v1';

  // ------- DOM -------
  const $meta = document.getElementById('meta');
  const $zoom = document.getElementById('zoom');
  const $nowBtn = document.getElementById('nowBtn');
  const $viewport = document.getElementById('viewport');
  const $canvas = document.getElementById('canvas');
  const $grid = document.getElementById('grid');
  const $lanes = document.getElementById('lanes');
  const $nowLine = document.getElementById('nowLine');

  // state
  let pxPerMin = parseFloat($zoom.value);
  let filterBelt = 'all';

  // ------- utils -------
  const pad = n => String(n).padStart(2,'0');
  const hhmm = d => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const toDate = iso => new Date(iso);
  const addMin = (d, m) => new Date(d.getTime() + m*60000);

  function keyOf(r){
    return `${(r.flight||'').trim()}|${(r.eta||'').slice(0,16)}`;
  }
  function loadCache(){
    try { return JSON.parse(localStorage.getItem(LS_KEY)||'[]'); } catch{ return []; }
  }
  function saveCache(arr){
    try { localStorage.setItem(LS_KEY, JSON.stringify(arr)); } catch{}
  }
  function mergeHistory(rows){
    const cache = loadCache();
    const map = new Map(cache.map(r => [keyOf(r), r]));
    for (const r of rows) {
      if (!r.eta) continue;
      map.set(keyOf(r), r);
    }
    // prune older than HISTORY_HOURS (by end time)
    const now = new Date();
    const cutoff = addMin(now, -HISTORY_HOURS*60);
    const kept = [];
    for (const r of map.values()){
      const endIso = r.end || r.eta;
      const end = toDate(endIso);
      if (end >= cutoff) kept.push(r);
    }
    saveCache(kept);
    return kept;
  }

  function classify(r){
    // status colour
    let cls = 'ok';
    const s = (r.status||'').toLowerCase();
    if (typeof r.delay_min === 'number') {
      if (r.delay_min >= 20) cls = 'y20';
      else if (r.delay_min >= 10) cls = 'y10';
      else if (r.delay_min < 0) cls = 'early';
      else cls = 'ok';
    } else {
      if (s.includes('delayed')) cls = 'y10';
      else if (s.includes('estimated')) cls = 'ok';
    }
    // fade if older than 60 min
    const now = new Date();
    const end = toDate(r.end || r.eta);
    const ageMin = Math.round((now - end)/60000);
    const faded = ageMin > FADE_AFTER_MIN;
    return { cls, faded };
  }

  function computeWindow(){
    const now = new Date();
    const backStart = addMin(now, -HISTORY_HOURS*60);         // past 4h
    const aheadEnd  = addMin(now,  DEFAULT_AHEAD_HOURS*60);   // next 3h
    return { start: addMin(backStart,-15), end: addMin(aheadEnd, 30), now };
  }

  function xFrom(rangeStart, date){ return (date - rangeStart)/60000 * pxPerMin; }

  function buildGrid(range){
    $grid.innerHTML = '';
    // Canvas width
    const minsTotal = Math.ceil((range.end - range.start)/60000);
    $canvas.style.width = `${minsTotal * pxPerMin + 200}px`;

    // Hour lines & labels
    const firstHour = new Date(range.start); firstHour.setMinutes(0,0,0);
    if (firstHour < range.start) firstHour.setHours(firstHour.getHours()+1);

    for (let t = new Date(firstHour); t <= range.end; t = addMin(t, 60)) {
      const left = xFrom(range.start, t);
      const el = document.createElement('div');
      el.className = 'grid-hour';
      el.style.left = `${left}px`;
      const label = document.createElement('div');
      label.className = 'label';
      label.textContent = hhmm(t);
      el.appendChild(label);
      $grid.appendChild(el);
    }

    // Now line
    const nowLeft = xFrom(range.start, range.now);
    $nowLine.style.left = `${Math.max(0, nowLeft)}px`;
  }

  function renderLanes(data, range){
    $lanes.innerHTML = '';
    const byBelt = new Map(BELTS.map(b => [b, []]));
    for (const r of data){
      if (!r.belt || !byBelt.has(Number(r.belt))) continue;
      if (filterBelt !== 'all' && Number(filterBelt) !== Number(r.belt)) continue;
      byBelt.get(Number(r.belt)).push(r);
    }

    for (const belt of BELTS){
      if (filterBelt !== 'all' && Number(filterBelt) !== belt) continue;

      const lane = document.createElement('div');
      lane.className = 'lane';
      const label = document.createElement('div');
      label.className = 'belt-label';
      label.textContent = `Belt ${belt}`;
      lane.appendChild(label);

      const rows = byBelt.get(belt)||[];
      for (const r of rows){
        const eta = toDate(r.eta);
        const start = r.start ? toDate(r.start) : addMin(eta, 15);
        const end   = r.end   ? toDate(r.end)   : addMin(start, 30);

        if (end < range.start || start > range.end) continue;

        const left = xFrom(range.start, start);
        const width = Math.max(4, (end - start)/60000 * pxPerMin);

        const { cls, faded } = classify(r);
        const puck = document.createElement('div');
        puck.className = `puck ${cls} ${faded ? 'faded':''}`;
        puck.style.left = `${left}px`;
        puck.style.width = `${width}px`;

        // Minimal in-puck text
        const flightAndOrigin = `${(r.flight||'').trim()} • ${(r.origin_iata||r.origin||'').replace(/[()]/g,'').trim()}`;
        const times = `${r.scheduled_local||'--:--'} → ${r.eta_local||'--:--'}`;

        puck.innerHTML = `
          <div class="col">
            <div class="title">${escapeHtml(flightAndOrigin)}</div>
            <div class="sub">${escapeHtml(times)}</div>
          </div>
        `;

        // Full details in native tooltip (hover)
        const details = [
          `Flight: ${(r.flight||'').trim()}`,
          `Origin: ${(r.origin||'').trim()} ${r.origin_iata?`(${r.origin_iata})`:''}`.trim(),
          `Scheduled → ETA: ${r.scheduled_local||'--:--'} → ${r.eta_local||'--:--'}`,
          `Status: ${r.status||'-'}`,
          `Belt: ${r.belt}`,
          `Start: ${fmtIso(r.start)}  End: ${fmtIso(r.end)}`,
          `Flow: ${r.flow||'-'}`,
          `Reason: ${r.reason||'-'}`
        ].join('\n');
        puck.setAttribute('title', details);

        lane.appendChild(puck);
      }

      $lanes.appendChild(lane);
    }
  }

  function fmtIso(iso){
    if(!iso) return '--:--';
    const d = new Date(iso);
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function escapeHtml(s){
    return String(s||'').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
  }

  async function loadAssignments(){
    const url = `assignments.json?v=${Date.now()}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to fetch ${url}`);
    const json = await res.json();
    $meta.textContent = `Generated ${json.generated_at_local || json.generated_at_utc || ''} • Horizon ${json.horizon_minutes||''} min`;
    return Array.isArray(json.rows) ? json.rows : [];
  }

  async function refresh(){
    try{
      const liveRows = await loadAssignments();
      const merged = mergeHistory(liveRows);
      const range = computeWindow();
      buildGrid(range);
      renderLanes(merged, range);
    } catch(e){
      console.error(e);
      $meta.textContent = 'Failed to load data. Retrying…';
    }
  }

  function centerOnNow(){
    const range = computeWindow();
    const left = Math.max(0, (range.now - range.start)/60000 * pxPerMin - ($viewport.clientWidth * 0.4));
    $viewport.scrollTo({ left, behavior:'smooth' });
  }

  // ------- events -------
  document.querySelectorAll('[data-belt]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      document.querySelectorAll('[data-belt]').forEach(b=>b.classList.remove('chip--primary'));
      btn.classList.add('chip--primary');
      filterBelt = btn.dataset.belt;
      refresh();
    });
  });

  $zoom.addEventListener('change', ()=>{
    pxPerMin = parseFloat($zoom.value);
    refresh();
  });

  $nowBtn.addEventListener('click', centerOnNow);

  // ------- boot -------
  refresh().then(centerOnNow);
  setInterval(refresh, 90*1000);
})();
