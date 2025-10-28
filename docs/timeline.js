// docs/timeline.js
// Combines current and past 4h allocations into one unified timeline view.

const LIVE_URL = "assignments.json";
const HISTORY_URL = "alloc-log.json";

async function fetchJson(url) {
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(res.statusText);
    return await res.json();
  } catch (err) {
    console.warn("⚠️ fetch failed for", url, err.message);
    return null;
  }
}

// Merge and filter data
function mergeRows(history, live) {
  const cutoff = Date.now() - 4 * 60 * 60 * 1000; // 4h ago
  const recentHistory = (history || []).filter(r => {
    const end = r.end ? new Date(r.end).getTime() : 0;
    return end > cutoff;
  });

  const all = [...recentHistory, ...(live?.rows || [])];
  // remove duplicates (same flight + start minute)
  const seen = new Set();
  const merged = all.filter(r => {
    const key = `${r.flight}|${(r.start || '').slice(0, 16)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Sort chronologically
  merged.sort((a, b) => new Date(a.start) - new Date(b.start));
  return merged;
}

// Flag past flights (for greying)
function markHistory(row) {
  const now = Date.now();
  const end = new Date(row.end).getTime();
  if (now > end + 2 * 60 * 1000) {
    row.isPast = true;
  }
  return row;
}

// Draw timeline (use your existing layout logic)
function drawTimeline(rows) {
  // Example placeholder — replace with your existing Gantt-drawing code.
  const container = document.getElementById("timeline");
  container.innerHTML = "";
  rows.forEach(r => {
    const div = document.createElement("div");
    div.className = "puck";
    div.style.top = `calc(${r.belt * 60}px)`;
    div.style.left = `${(new Date(r.start) - Date.now()) / 60000 * 8}px`;
    div.style.width = `${(new Date(r.end) - new Date(r.start)) / 60000 * 8}px`;
    div.textContent = `${r.flight} ${r.origin_iata} ${r.eta_local}`;
    if (r.isPast) div.style.opacity = "0.4";
    container.appendChild(div);
  });
}

// Main
async function init() {
  const [history, live] = await Promise.all([
    fetchJson(HISTORY_URL),
    fetchJson(LIVE_URL)
  ]);

  const merged = mergeRows(history, live).map(markHistory);
  drawTimeline(merged);
}

document.addEventListener("DOMContentLoaded", init);
