/**
 * feeder/fr24_feeder.js
 *
 * PURPOSE
 * -------
 * Read docs/assignments.json, re-run belt allocation rules
 * (CTA→6, DOMESTIC→7, INTERNATIONAL spread 1/2/3/5, heavy→5,
 *   fallback to earliest-clearing belt),
 * then write it back.
 *
 * This is ESM (package.json type: "module").
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const ASSIGNMENTS_PATH = path.join(__dirname, "..", "docs", "assignments.json");

const MIN_GAP_MIN = 1;
const BELTS_ALL   = [1,2,3,5,6,7];

// same helpers as snap

function toMs(t) {
  return (t instanceof Date) ? +t : +new Date(t);
}

function overlapsOrTooClose(a, b, minGapMin) {
  if (!a.start || !a.end || !b.start || !b.end) return false;
  const s1 = toMs(a.start);
  const e1 = toMs(a.end);
  const s2 = toMs(b.start);
  const e2 = toMs(b.end);

  if (s1 < e2 && s2 < e1) return true;

  const gap1 = Math.abs(s2 - e1) / 60000;
  const gap2 = Math.abs(s1 - e2) / 60000;
  if (gap1 < minGapMin || gap2 < minGapMin) return true;

  return false;
}

function initUsage() {
  const usage = {};
  for (const b of BELTS_ALL) usage[b] = [];
  return usage;
}

function canPlaceStrict(flight, belt, usage) {
  const slots = usage[belt] || [];
  for (const slot of slots) {
    if (overlapsOrTooClose(flight, slot.flightRef, MIN_GAP_MIN)) {
      return false;
    }
  }
  return true;
}

function recordPlacement(flight, belt, usage, reasonText) {
  flight.belt = belt;
  if (reasonText) {
    flight.reason = reasonText;
  }
  usage[belt].push({
    startMs: toMs(flight.start),
    endMs: toMs(flight.end),
    flightRef: flight
  });
  usage[belt].sort((a, b) => a.startMs - b.startMs);
}

function pickEarliestClearingBelt(allowedBelts, usage) {
  let bestBelt = allowedBelts[0];
  let bestEnd = Infinity;
  for (const b of allowedBelts) {
    const slots = usage[b];
    if (!slots || slots.length === 0) {
      return b;
    }
    const last = slots[slots.length - 1];
    if (last.endMs < bestEnd) {
      bestEnd = last.endMs;
      bestBelt = b;
    }
  }
  return bestBelt;
}

function beltPriorityList(flight) {
  const airlineLower = (flight.airline || "").toLowerCase();
  const isHeavy =
    airlineLower.includes("jet2") ||
    airlineLower.includes("tui") ||
    (typeof flight.pax_estimate === "number" && flight.pax_estimate >= 150);

  if (flight.flow === "DOMESTIC") {
    return [7];
  }
  if (flight.flow === "CTA") {
    return [6];
  }

  if (isHeavy) {
    return [5,1,2,3];
  } else {
    return [1,2,3,5];
  }
}

function assignBeltsAgain(rowsIn) {
  const rows = rowsIn.map(r => ({ ...r }));

  rows.sort((a, b) => {
    const ta = a.eta ? Date.parse(a.eta) : (a.start ? Date.parse(a.start) : Infinity);
    const tb = b.eta ? Date.parse(b.eta) : (b.start ? Date.parse(b.start) : Infinity);
    return ta - tb;
  });

  const usage = initUsage();

  for (const f of rows) {
    // if already valid belt in [1,2,3,5,6,7], keep and record
    const currentBelt = parseInt(f.belt, 10);
    if (BELTS_ALL.includes(currentBelt)) {
      recordPlacement(f, currentBelt, usage, f.reason || "");
      continue;
    }

    const priorities = beltPriorityList(f);

    let placed = false;
    for (const b of priorities) {
      if (canPlaceStrict(f, b, usage)) {
        let r = f.reason || "";
        if (f.flow === "DOMESTIC") r = "domestic→7";
        else if (f.flow === "CTA") r = "cta→6";
        else if (b === 5) r = "heavy→5";
        else r = "intl_spread";
        recordPlacement(f, b, usage, r);
        placed = true;
        break;
      }
    }

    if (!placed) {
      const fb = pickEarliestClearingBelt(priorities, usage);
      let r = f.reason || "stacked";
      if (f.flow === "DOMESTIC") r = "domestic→7";
      else if (f.flow === "CTA") r = "cta→6";
      recordPlacement(f, fb, usage, r);
    }
  }

  return rows;
}

async function run() {
  try {
    const raw = fs.readFileSync(ASSIGNMENTS_PATH, "utf8");
    const parsed = JSON.parse(raw);

    const meta = {
      generated_at_utc:   parsed.generated_at_utc   || "",
      generated_at_local: parsed.generated_at_local || "",
      source:             parsed.source             || "",
      horizon_minutes:    parsed.horizon_minutes    || 0
    };

    const rows = Array.isArray(parsed.rows) ? parsed.rows : [];
    const fixedRows = assignBeltsAgain(rows);

    const outObj = {
      generated_at_utc:   meta.generated_at_utc,
      generated_at_local: meta.generated_at_local,
      source:             meta.source,
      horizon_minutes:    meta.horizon_minutes,
      rows:               fixedRows
    };

    fs.writeFileSync(ASSIGNMENTS_PATH, JSON.stringify(outObj, null, 2), "utf8");
    console.log("[feeder] assignments.json updated with CTA/DOM/INT belts and no belt 4.");
  } catch (err) {
    console.error("[feeder] ERROR:", err);
    process.exitCode = 1;
  }
}

run();
