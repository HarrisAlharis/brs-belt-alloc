/* docs/timeline.js
 * BRS — Arrivals Belt Timeline (full drop-in file)
 * - Reads docs/assignments.json
 * - Builds an interactive timeline with horizontal scroll + sticky header/left rail
 * - Packs overlapping flights into vertical lanes per belt
 * - NEW: collision padding (1 minute) so adjacent/overlapping pucks do not overlap
 */

(() => {
  // ---------- Config ----------
  const JSON_URL = "assignments.json";
  const HISTORY_KEEP_HOURS = 4;      // keep last 4h locally (already used on page)
  const NOW_LINE_TICK_MS = 20 * 1000;
  const REFRESH_MS = 90 * 1000;

  // Zoom options in px per minute
  const ZOOMS = [
    { label: "3 px/min (narrow)", ppm: 3 },
    { label: "6 px/min (default)", ppm: 6 },
    { label: "9 px/min (wide)",    ppm: 9 },
    { label: "12 px/min (extra)",  ppm: 12 },
  ];
  let currentZoom = ZOOMS[1]; // default

  // ---------- Elements ----------
  const elHeader   = document.getElementById("tl-header");   // time scale (sticky)
  const elLeft     = document.getElementById("tl-left");     // belts (sticky)
  const elBody     = document.getElementById("tl-body");     // scrollable body
  const elScroller = document.getElementById("tl-scrollbar");// custom horizontal scrollbar
  const elZoomSel  = document.getElementById("zoom-select"); // <select> for zoom
  const elNowBtn   = document.getElementById("btn-now");     // “Now” button
  const elGenInfo  = document.getElementById("gen-info");    // small generated label

  // Guards for missing DOM (in case the HTML wasn’t updated yet)
  if (!elHeader || !elLeft || !elBody) {
    console.warn("[timeline] Missing required DOM nodes. Make sure timeline.html is up to date.");
    return;
  }

  // Populate zoom select
  if (elZoomSel) {
    elZoomSel.innerHTML = ZOOMS.map((z, i) =>
      `<option value="${i}" ${z === currentZoom ? "selected" : ""}>${z.label}</option>`
    ).join("");
    elZoomSel.addEventListener("change", () => {
      const idx = parseInt(elZoomSel.value, 10);
      currentZoom = ZOOMS[idx] || currentZoom;
      rebuild();
    });
  }

  // ---------- Time helpers ----------
  const toMs = d => (d instanceof Date ? d.getTime() : +new Date(d));
  const fmtHHmm = d => {
    const dt = (d instanceof Date) ? d : new Date(d);
    return dt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  };

  // ---------- State ----------
  let rows = [];              // normalized rows from JSON (with start/end as Date)
  let belts = [];             // discovered belts + “Belt 1..7”
  let timeWindow = { start: null, end: null };  // min/max for rendering
  let nowLineEl = null;

  // Local history cache to keep last 4h for context (avoid losing older pucks until they age out)
  const CACHE_KEY = "brs_tl_cache_v2";

  function loadCache() {
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      if (!raw) return [];
      const arr = JSON.parse(raw);
      const cutoff = Date.now() - HISTORY_KEEP_HOURS * 3600 * 1000;
      return arr.filter(x => toMs(x.end) >= cutoff);
    } catch (e) {
      return [];
    }
  }
  function saveCache(list) {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify(list));
    } catch (e) {}
  }

  // Merge new rows into cache by (flight, start-min)
  function mergeHistory(newRows) {
    const cache = loadCache();
    const key = r => `${(r.flight || "").trim()}|${new Date(r.start).toISOString().slice(0,16)}`;
    const seen = new Map(cache.map(r => [key(r), r]));
    for (const r of newRows) seen.set(key(r), r);
    const out = [...seen.values()];
    saveCache(out);
    return out;
  }

  // ---------- Data fetch & normalization ----------
  async function fetchJSON() {
    const res = await fetch(JSON_URL, { cache: "no-store" });
    if (!res.ok) throw new Error(`Failed fetch ${JSON_URL}: ${res.status}`);
    return res.json();
  }

  function normalize(json) {
    const list = (json.rows || []).map(r => ({
      flight: r.flight || "",
      belt: r.belt || "",
      flow: r.flow || "",
      origin: r.origin_iata || r.origin || "",
      start: r.start ? new Date(r.start) : new Date(toMs(r.eta) + 15 * 60000), // fallback
      end:   r.end   ? new Date(r.end)   : new Date(toMs(r.eta) + 45 * 60000),
      delay: typeof r.delay_min === "number" ? r.delay_min : null,
      status: r.status || "",
      eta: r.eta ? new Date(r.eta) : null,
      scheduled_local: r.scheduled_local || "",
      eta_local: r.eta_local || "",
      reason: r.reason || "",
      airline: r.airline || "",
      aircraft: r.aircraft || "",
      ui_state: r.ui_state || "",
    }))
      // render only rows with a valid belt number 1,2,3,5,6,7
      .filter(r => String(r.belt).match(/^[1-7]$/));

    return { list, meta: json };
  }

  function discoverBelts(list) {
    // Always show 1,2,3,5,6,7 (in order)
    const fixed = [1,2,3,5,6,7];
    const present = Array.from(new Set(list.map(r => +r.belt))).sort((a,b)=>a-b);
    const out = fixed.filter(b => present.includes(b));
    // also keep missing ones to preserve rows (if none present, still show all)
    for (const b of fixed) if (!out.includes(b)) out.push(b);
    return out;
  }

  // ---------- Layout calculations ----------
  function computeWindow(list) {
    if (!list.length) {
      const now = Date.now();
      return {
        start: new Date(now - 60*60000),
        end:   new Date(now + 120*60000)
      };
    }
    const minStart = Math.min(...list.map(r => +r.start));
    const maxEnd   = Math.max(...list.map(r => +r.end));
    const padMin = 45; // pad around
    return {
      start: new Date(minStart - padMin * 60000),
      end:   new Date(maxEnd + padMin * 60000)
    };
  }

  // map time->x using current zoom and window
  function timeToX(ms) {
    const ppm = currentZoom.ppm;
    return (ms - toMs(timeWindow.start)) / 60000 * ppm;
  }

  // ---------- Lane packing (per belt) ----------
  // NEW: 1-minute collision padding so pucks never overlap visually.
  function packLanes(flightsForBelt){
    const items = flightsForBelt
      .slice()
      .sort((a,b)=>+a.start - +b.start);

    const lanes = []; // store lastEndMs per lane
    const bufferMs = 1 * 60 * 1000; // 1 minute

    for (const f of items){
      const start = +f.start;
      const end   = +f.end;
      let placed = -1;

      for (let i=0; i<lanes.length; i++){
        const lastEnd = lanes[i];
        if (start >= lastEnd + bufferMs){
          placed = i; break;
        }
      }

      if (placed === -1){
        lanes.push(end);
        f._lane = lanes.length - 1;
      } else {
        lanes[placed] = end;
        f._lane = placed;
      }
    }

    return { lanesCount: Math.max(1, lanes.length), items };
  }

  // ---------- Rendering ----------
  function clear(el){ while (el.firstChild) el.removeChild(el.firstChild); }

  function renderHeader() {
    clear(elHeader);
    const wrap = document.createElement("div");
    wrap.className = "tl-header-scale";

    const totalMin = Math.max(30, Math.ceil((toMs(timeWindow.end) - toMs(timeWindow.start)) / 60000));
    // major every 60 min, minor every 15 min
    for (let m = 0; m <= totalMin; m += 15) {
      const t = new Date(toMs(timeWindow.start) + m * 60000);
      const x = Math.round(timeToX(toMs(t)));

      const tick = document.createElement("div");
      tick.className = "tick";
      tick.style.left = x + "px";
      if (t.getMinutes() === 0) {
        tick.classList.add("major");
        const lab = document.createElement("div");
        lab.className = "tick-label";
        lab.textContent = fmtHHmm(t);
        tick.appendChild(lab);
      }
      wrap.appendChild(tick);
    }

    elHeader.appendChild(wrap);
  }

  function renderLeft() {
    clear(elLeft);
    for (const b of belts) {
      const row = document.createElement("div");
      row.className = "belt-row";
      row.textContent = `Belt ${b}`;
      elLeft.appendChild(row);
    }
  }

  function laneHeight(lanesCount) {
    // Compact when many lanes
    if (lanesCount >= 4) return 90;
    if (lanesCount === 3) return 110;
    return 130;
  }

  function renderBody() {
    clear(elBody);

    // group by belt
    const byBelt = new Map();
    for (const r of rows) {
      if (!byBelt.has(r.belt)) byBelt.set(r.belt, []);
      byBelt.get(r.belt).push(r);
    }

    const headerW = Math.ceil(timeToX(toMs(timeWindow.end)));
    elHeader.style.width = headerW + "px";

    for (const b of belts) {
      const beltRow = document.createElement("div");
      beltRow.className = "tl-row";
      beltRow.style.width = headerW + "px";

      const flights = byBelt.get(b) || [];
      const packed = packLanes(flights);
      const h = laneHeight(packed.lanesCount);
      beltRow.style.setProperty("--row-height", `${h}px`);

      for (const f of packed.items) {
        const x  = Math.round(timeToX(+f.start));
        const xe = Math.round(timeToX(+f.end));
        const w  = Math.max(36, xe - x); // min width

        const y = f._lane * (h / Math.max(1, packed.lanesCount));

        const puck = document.createElement("div");
        puck.className = "puck";
        puck.style.left = x + "px";
        puck.style.top  = y + "px";
        puck.style.width = w + "px";

        // color by delay
        let cls = "onTime";
        if (typeof f.delay === "number") {
          if (f.delay >= 20) cls = "late20";
          else if (f.delay >= 10) cls = "late10";
        }
        puck.classList.add(cls);

        // label (short)
        const title = document.createElement("div");
        title.className = "puck-title";
        const code = (f.flight || "").trim();
        const o = (f.origin || "").trim();
        title.textContent = (code ? `${code}` : "•") + (o ? ` • ${o}` : "");
        puck.appendChild(title);

        const times = document.createElement("div");
        times.className = "puck-times";
        times.textContent = `${fmtHHmm(f.start)} → ${fmtHHmm(f.end)}`;
        puck.appendChild(times);

        // tooltip (on hover)
        const tip = document.createElement("div");
        tip.className = "puck-tip";
        tip.innerHTML = `
          <div><strong>${code || "N/A"}</strong> • ${f.origin || ""}</div>
          <div>${fmtHHmm(f.start)} → ${fmtHHmm(f.end)}</div>
          <div>${(f.flow || "").toUpperCase()}</div>
          ${f.reason ? `<div>Reason: ${f.reason}</div>` : ""}
          ${f.status ? `<div>Status: ${f.status}</div>` : ""}
        `;
        puck.appendChild(tip);

        beltRow.appendChild(puck);
      }

      elBody.appendChild(beltRow);
    }

    renderNowLine(); // create/update now line
    syncScrollbars();
  }

  // ---------- Now line ----------
  function renderNowLine() {
    const nowX = timeToX(Date.now());
    if (!nowLineEl) {
      nowLineEl = document.createElement("div");
      nowLineEl.className = "now-line";
      elBody.appendChild(nowLineEl);
    }
    nowLineEl.style.left = Math.round(nowX) + "px";
    nowLineEl.style.height = elBody.scrollHeight + "px";
  }
  setInterval(() => renderNowLine(), NOW_LINE_TICK_MS);

  // ---------- Scroll sync ----------
  // We keep header & left rail sticky by CSS. Here we sync the custom scrollbar.
  function syncScrollbars() {
    // set custom range
    const maxX = Math.max(0, elHeader.scrollWidth - elBody.clientWidth);
    if (elScroller) {
      elScroller.max = maxX;
      elScroller.value = elBody.scrollLeft;
    }
  }
  if (elScroller) {
    elScroller.addEventListener("input", () => {
      elBody.scrollLeft = Number(elScroller.value);
      elHeader.scrollLeft = elBody.scrollLeft; // keep marks aligned
    });
  }
  elBody.addEventListener("scroll", () => {
    elHeader.scrollLeft = elBody.scrollLeft;
    syncScrollbars();
  });

  if (elNowBtn) {
    elNowBtn.addEventListener("click", () => {
      const nowX = timeToX(Date.now());
      const center = nowX - elBody.clientWidth / 2;
      elBody.scrollTo({ left: Math.max(0, center), behavior: "smooth" });
    });
  }

  // ---------- Build ----------
  async function rebuild() {
    // Merge history (keeps last 4h in browser)
    const merged = mergeHistory(rows);
    rows = merged;

    belts = discoverBelts(rows);
    timeWindow = computeWindow(rows);

    renderHeader();
    renderLeft();
    renderBody();
  }

  async function loadAndRender() {
    try {
      const json = await fetchJSON();
      if (elGenInfo) {
        const t = json.generated_at_local || json.generated_at_utc || "";
        const hz = json.horizon_minutes ? ` • Horizon ${json.horizon_minutes} min` : "";
        elGenInfo.textContent = `Generated ${t}${hz}`;
      }
      const { list } = normalize(json);
      rows = list;
      await rebuild();
    } catch (e) {
      console.error("[timeline] load error", e);
    }
  }

  // Auto-refresh
  setInterval(loadAndRender, REFRESH_MS);

  // First load
  loadAndRender();
})();
