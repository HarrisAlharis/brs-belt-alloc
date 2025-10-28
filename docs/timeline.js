// docs/timeline.js
// Updated: adds 4-hour history from alloc-log.json, merges with current assignments.

const ASSIGN_URL = "assignments.json";
const HISTORY_URL = "alloc-log.json";

async function fetchJson(url) {
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    console.warn("fetch failed:", url, err.message);
    return null;
  }
}

function buildKey(r) {
  const f = (r.flight || "").trim() || (r.airline || "").trim() || "UNK";
  const start = (r.start || "").slice(0, 16);
  return `${f}|${start}`;
}

function combineRows(hist, live) {
  const map = new Map();
  for (const r of (hist || [])) map.set(buildKey(r), r);
  for (const r of (live || [])) map.set(buildKey(r), r);
  const merged = Array.from(map.values());
  merged.sort((a,b) => new Date(a.start) - new Date(b.start));
  return merged;
}

function renderTimeline(rows) {
  // === Your existing drawing logic ===
  // This section must match your previous code that draws the timeline.
  // Replace this placeholder with the code you already had for building
  // the Gantt bars. If you copy the file on top of your old timeline.js,
  // everything below this comment will already exist.
  console.log(`Rendering ${rows.length} items`);
  drawTimeline(rows); // assuming you already have drawTimeline()
}

async function init() {
  const [hist, assignData] = await Promise.all([
    fetchJson(HISTORY_URL),
    fetchJson(ASSIGN_URL)
  ]);

  const histRows = hist && Array.isArray(hist) ? hist : hist?.rows || [];
  const liveRows = assignData && Array.isArray(assignData.rows) ? assignData.rows : [];

  const allRows = combineRows(histRows, liveRows);
  renderTimeline(allRows);
}

document.addEventListener("DOMContentLoaded", init);
