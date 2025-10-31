/**
 * feeder/fr24_feeder.js
 *
 * STEP 2: post-process docs/assignments.json
 *
 * We:
 *   - classify flow as CTA / DOMESTIC / INTERNATIONAL
 *   - set belt rules (1,2,3,5,6 normal, 6 for CTA, 7 for DOMESTIC)
 *   - prioritise heavy (Jet2 / TUI / big pax) on belt 5 if it's free
 *   - forbid belt 4 completely
 *   - open belt 15 min after ETA, close 45 min after ETA
 *   - if belts clash, we pick the belt that clears the soonest
 *
 * OUTPUT (overwrite same file):
 *   docs/assignments.json with updated rows
 *
 * RUN ORDER:
 *   node feeder/fr24_snap.js
 *   node feeder/fr24_feeder.js
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ASSIGNMENTS_PATH = path.join(
  __dirname,
  "..",
  "docs",
  "assignments.json"
);

// -------------------- CONFIG --------------------

const BELT_START_OFFSET_MIN = 15; // start 15 min after ETA
const BELT_TOTAL_WINDOW_MIN = 45; // end 45 min after ETA
const MIN_GAP_MIN = 1; // at least 1 min separation between belt uses

// belts allowed at the airport
// NOTE: there's no belt 4
const BELT_DOMESTIC = 7; // strictly domestic/UK flows
const BELT_CTA = 6; // strictly CTA flows (Ireland, Channel Islands, IoM)
const INT_ORDER = [1, 2, 3, 5, 6]; // normal spill order for INTERNATIONAL
// 1,2,3 low load first
// 5 = long belt for heavier loads (Jet2 / TUI etc)
// 6 = absolute last resort for INTL, after 1,2,3,5

// CTA airport codes (Common Travel Area excl. NI as per ops practice)
const CTA_CODES = new Set([
  "DUB", // Dublin
  "ORK", // Cork
  "SNN", // Shannon
  "NOC", // Ireland West / Knock
  "KIR", // Kerry
  "CFN", // Donegal
  "IOM", // Isle of Man / Ronaldsway
  "JER", // Jersey
  "GCI", // Guernsey
  "ACI", // Alderney
]);

// Domestic UK (treated as internal UK flow operationally, includes NI)
const DOM_CODES = new Set([
  // England / Wales / Scotland / NI domestic list you gave
  "LHR",
  "LGW",
  "LCY",
  "LTN",
  "STN",
  "SEN",
  "BHX",
  "MAN",
  "LPL",
  "EMA",
  "NCL",
  "LBA",
  "MME",
  "HUY",
  "NWI",
  "BRS",
  "EXT",
  "NQY",
  "BOH",
  "SOU",
  "CAX",
  "CWL",
  "VLY",
  "EDI",
  "GLA",
  "PIK",
  "ABZ",
  "INV",
  "DND",
  "LSI",
  "LWK",
  "KOI",
  "WIC",
  "SYY",
  "BEB",
  "BRR",
  "TRE",
  "CAL",
  "OBN",
  "BFS",
  "BHD",
  "LDY",
]);

function classifyFlow(originIata) {
  const code = (originIata || "").toUpperCase();
  if (CTA_CODES.has(code)) return "CTA";
  if (DOM_CODES.has(code)) return "DOMESTIC";
  return "INTERNATIONAL";
}

function addMinutesIso(iso, mins) {
  if (!iso) return null;
  const d = new Date(iso);
  return new Date(d.getTime() + mins * 60000).toISOString();
}

function toMs(t) {
  if (!t) return Infinity;
  return +new Date(t);
}

function overlapsOrTooClose(f1, f2) {
  // true if times on the same belt collide or are <1min apart
  const s1 = toMs(f1.start);
  const e1 = toMs(f1.end);
  const s2 = toMs(f2.start);
  const e2 = toMs(f2.end);

  // overlap
  if (s1 < e2 && s2 < e1) return true;

  // gap check
  const gap1 = Math.abs(s2 - e1) / 60000;
  const gap2 = Math.abs(s1 - e2) / 60000;
  if (gap1 < MIN_GAP_MIN || gap2 < MIN_GAP_MIN) return true;

  return false;
}

function initUsage() {
  // track which slots are already on each belt
  return {
    1: [],
    2: [],
    3: [],
    5: [],
    6: [],
    7: [],
  };
}

function canPlaceOnBeltStrict(flight, belt, usage) {
  const slots = usage[belt] || [];
  for (const slot of slots) {
    if (overlapsOrTooClose(flight, slot.flightRef)) {
      return false;
    }
  }
  return true;
}

function recordPlacement(flight, belt, reason, usage) {
  flight.belt = belt;
  if (reason) flight.reason = reason;
  usage[belt].push({
    startMs: toMs(flight.start),
    endMs: toMs(flight.end),
    flightRef: flight,
  });
  usage[belt].sort((a, b) => a.startMs - b.startMs);
}

function earliestClearingBelt(order, usage) {
  // pick belt whose latest assigned slot ends the soonest
  let bestBelt = order[0];
  let bestEnd = Infinity;

  for (const b of order) {
    const arr = usage[b] || [];
    const last = arr[arr.length - 1];
    const endMs = last ? last.endMs : 0;
    if (endMs < bestEnd) {
      bestEnd = endMs;
      bestBelt = b;
    }
  }
  return bestBelt;
}

// A heavy flight is something like Jet2 / TUI / larger pax
// We bias them to belt 5 IF it's free. But we don't stack belt 5 if 1/2/3 are free.
function isHeavyFlight(row) {
  const airline = (row.airline || "").toLowerCase();
  if (airline.includes("tui")) return true;
  if (airline.includes("jet2")) return true;
  if (typeof row.pax_estimate === "number" && row.pax_estimate >= 170)
    return true;
  return false;
}

// normalise times and flow for each row
function prepRow(r) {
  const flow = classifyFlow(r.origin_iata);
  r.flow = flow;

  // belt window is always ETA+15 to ETA+45
  if (r.eta) {
    const startIso = addMinutesIso(r.eta, BELT_START_OFFSET_MIN);
    const endIso = addMinutesIso(r.eta, BELT_TOTAL_WINDOW_MIN);
    r.start = startIso;
    r.end = endIso;
  }

  return r;
}

function assignBelts(allRows) {
  // clone objects so we can mutate safely
  const rows = allRows.map((r) => ({ ...r }));

  // normalise flow / times first
  for (const r of rows) {
    prepRow(r);
  }

  // sort chronologically by start time
  rows.sort((a, b) => toMs(a.start) - toMs(b.start));

  const usage = initUsage();

  for (const f of rows) {
    // DOMESTIC → belt 7 only (must stay domestic)
    if (f.flow === "DOMESTIC") {
      if (canPlaceOnBeltStrict(f, BELT_DOMESTIC, usage)) {
        recordPlacement(f, BELT_DOMESTIC, "dom→7", usage);
      } else {
        // no alternative allowed, force anyway
        recordPlacement(f, BELT_DOMESTIC, "dom→7", usage);
      }
      continue;
    }

    // CTA → belt 6 only
    if (f.flow === "CTA") {
      if (canPlaceOnBeltStrict(f, BELT_CTA, usage)) {
        recordPlacement(f, BELT_CTA, "cta→6", usage);
      } else {
        // again, CTA stays belt 6 even if overlapping
        recordPlacement(f, BELT_CTA, "cta→6", usage);
      }
      continue;
    }

    // INTERNATIONAL
    const heavy = isHeavyFlight(f);

    // HEAVY priority: if belt 5 is completely free for this time, take it
    if (heavy && canPlaceOnBeltStrict(f, 5, usage)) {
      recordPlacement(f, 5, "heavy→5", usage);
      continue;
    }

    // otherwise try 1,2,3,5,6 in that order, but skipping any that collide
    let placed = false;
    for (const b of INT_ORDER) {
      if (canPlaceOnBeltStrict(f, b, usage)) {
        recordPlacement(f, b, "intl_spread", usage);
        placed = true;
        break;
      }
    }

    if (!placed) {
      // all belts clashing at that exact minute:
      // pick the one that clears first
      const fb = earliestClearingBelt(INT_ORDER, usage);
      recordPlacement(f, fb, "fallback_busy", usage);
    }
  }

  return rows;
}

// ---- I/O ----

function loadAssignments() {
  const raw = fs.readFileSync(ASSIGNMENTS_PATH, "utf8");
  const parsed = JSON.parse(raw);

  const meta = {
    generated_at_utc: parsed.generated_at_utc || "",
    generated_at_local: parsed.generated_at_local || "",
    source: parsed.source || "",
    horizon_minutes: parsed.horizon_minutes || 0,
  };

  const rows = Array.isArray(parsed.rows) ? parsed.rows : [];
  return { meta, rows };
}

function writeAssignments(meta, fixedRows) {
  // stable key order for output rows
  const orderedRows = fixedRows.map((r) => ({
    flight: r.flight || "",
    origin: r.origin || "",
    origin_iata: r.origin_iata || "",
    eta: r.eta || null,
    status: r.status || "",
    flow: r.flow || "",
    belt: r.belt ?? "",
    start: r.start || null,
    end: r.end || null,
    reason: r.reason || "",
    airline: r.airline || "",
    aircraft: r.aircraft || "",
    pax_estimate:
      typeof r.pax_estimate === "number" ? r.pax_estimate : null,
    scheduled_local: r.scheduled_local || "",
    eta_local: r.eta_local || "",
    delay_min:
      typeof r.delay_min === "number" ? r.delay_min : null,
    ui_state: r.ui_state || "upcoming",
    ui_age_min:
      typeof r.ui_age_min === "number" ? r.ui_age_min : 0,
  }));

  const outObj = {
    generated_at_utc: meta.generated_at_utc,
    generated_at_local: meta.generated_at_local,
    source: meta.source,
    horizon_minutes: meta.horizon_minutes,
    rows: orderedRows,
  };

  fs.writeFileSync(
    ASSIGNMENTS_PATH,
    JSON.stringify(outObj, null, 2),
    "utf8"
  );
}

async function run() {
  try {
    const { meta, rows } = loadAssignments();
    const fixedRows = assignBelts(rows);
    writeAssignments(meta, fixedRows);
    console.log(
      "[fr24_feeder] assignments.json updated with flow, belts, and windows."
    );
  } catch (err) {
    console.error("[fr24_feeder] ERROR:", err);
    process.exitCode = 1;
  }
}

run();
