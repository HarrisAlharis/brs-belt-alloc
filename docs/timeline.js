// docs/timeline.js
// Unified baggage belt timeline: last 4h + current/upcoming allocations

const LIVE_URL = "assignments.json";
const HISTORY_URL = "alloc-log.json";

async function fetchJson(url) {
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(res.statusText);
    return await res.json();
  } catch (err) {
    console.warn("⚠️ Fetch failed:", url, err.message);
    return null;
  }
}

function mergeRows(history, live) {
  const cutoff = Date.now() - 4 * 60 * 60 * 1000; // 4h ago
  const histRows = Array.isArray(history)
    ? history.filter(r => new Date(r.end).getTime() > cutoff)
    : Array.isArray(history?.rows)
    ? history.rows.filter(r => new Date(r.end).getTime() > cutoff)
    : [];

  const liveRows = Array.isArray(live?.rows) ? live.rows : [];

  const seen = new Set();
  const all = [...histRows, ...liveRows].filter(r => {
    const key = `${r.flight}|${(r.start || "").slice(0, 16)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  all.sort((a, b) => new Date(a.start) - new Date(b.start));
  return all;
}

function markHistory(row) {
  const now = Date.now();
  const end = new Date(row.end).getTime();
  row.isPast = now > end + 2 * 60 * 1000;
  return row;
}

// Draw function (safe minimal)
function drawTimeline(rows) {
  const container = document.getElementById("timeline");
  if (!container) {
    console.error("❌ Missing #timeline element in HTML");
    return;
  }
  container.innerHTML = "";

  if (!rows || rows.length === 0) {
    container.innerHTML = "<p style='color:#666'>No timeline data found.</p>";
    console.warn("⚠️ No timeline data found");
    return;
  }

  // 8px = 1 minute scale
  const PX_PER_MIN = 8;
  const now = Date.now();

  for (const r of rows) {
    const start = new Date(r.start).getTime();
    const end = new Date(r.end).getTime();
    const minsFromNow = (start - now) / 60000;
    const durationMin = (end - start) / 60000;

    const puck = document.createElement("div");
    puck.className = "puck";
    puck.style.position = "absolute";
    puck.style.left = `${minsFromNow * PX_PER_MIN + 1000}px`; // offset for view
    puck.style.top = `${(r.belt || 1) * 50}px`;
    puck.style.width = `${durationMin * PX_PER_MIN}px`;
    puck.style.height = "24px";
    puck.style.borderRadius = "4px";
    puck.style.background = r.isPast ? "#bbb" : "#3cb371";
    puck.style.opacity = r.isPast ? "0.5" : "1";
    puck.style.color = "#000";
    puck.style.font = "12px Arial, sans-serif";
    puck.style.display = "flex";
    puck.style.alignItems = "center";
    puck.style.justifyContent = "center";
    puck.textContent = `${r.flight} ${r.origin_iata || ""} ${r.eta_local || ""}`;
    container.appendChild(puck);
  }
}

async function init() {
  console.log("⏳ Loading timeline data...");
  const [history, live] = await Promise.all([
    fetchJson(HISTORY_URL),
    fetchJson(LIVE_URL)
  ]);

  const merged = mergeRows(history, live).map(markHistory);
  console.log(`✅ Loaded ${merged.length} total records`);
  drawTimeline(merged);
}

document.addEventListener("DOMContentLoaded", init);
