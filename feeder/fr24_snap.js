// feeder/fr24_snap.js
// LIVE scrape FR24 → normalised assignments.json for the webpage
// - Cleans FR24 rows into a consistent shape
// - Classifies flow (INTERNATIONAL / CTA / DOMESTIC)
// - Computes belt window: start = ETA+15, end = ETA+45
// - Allocates belts using airport rules (no belt 4)
// - Writes docs/assignments.json

import fs from "fs";
import path from "path";
import puppeteer from "puppeteer";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// OUTPUT
const OUTPUT_PATH = path.join(__dirname, "..", "docs", "assignments.json");

// SOURCE
const FR24_URL = "https://www.flightradar24.com/data/airports/brs/arrivals";

// CONFIG
const HORIZON_MIN = 180; // keep ~3h ahead
const MIN_GAP_MIN = 1;   // min gap between two flights on same belt
const BELTS_ALL = [1, 2, 3, 5, 6, 7]; // valid belts. NO BELT 4.

// CTA codes (Common Travel Area, *not* UK domestic reclaim)
const CTA_CODES = new Set([
  "DUB","ORK","SNN","NOC","KIR","CFN",
  "IOM","JER","GCI","ACI"
]);

// UK domestic codes (treated as domestic arrivals for reclaim)
const DOMESTIC_CODES = new Set([
  // England
  "LHR","LGW","LCY","LTN","STN","SEN","BHX","MAN","LPL","EMA","NCL","LBA","MME",
  "HUY","NWI","BRS","EXT","NQY","BOH","SOU","CAX",
  // Wales
  "CWL","VLY",
  // Scotland
  "EDI","GLA","PIK","ABZ","INV","DND","LSI","LWK","KOI","WIC","SYY","BEB","BRR",
  "TRE","CAL","OBN",
  // Northern Ireland
  "BFS","BHD","LDY"
]);

// ---------- small helpers ----------

function addMinutesISO(iso, mins) {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  const out = new Date(t + mins * 60000);
  return out.toISOString();
}

function todayIsoFromHHMM(hhmm) {
  if (!hhmm) return null;
  const now = new Date();
  const [hh, mm] = hhmm.split(":").map(Number);
  const d = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    hh,
    mm,
    0,
    0
  );
  return d.toISOString();
}

function calcDelayMin(schedHHMM, etaHHMM) {
  if (!schedHHMM || !etaHHMM) return null;
  const n = new Date();
  const [sh, sm] = schedHHMM.split(":").map(Number);
  const [eh, em] = etaHHMM.split(":").map(Number);
  const s = new Date(n.getFullYear(), n.getMonth(), n.getDate(), sh, sm, 0, 0);
  const e = new Date(n.getFullYear(), n.getMonth(), n.getDate(), eh, em, 0, 0);
  return Math.round((e - s) / 60000);
}

// classify CTA / DOMESTIC / INTERNATIONAL
function classifyFlow(originIataUpper) {
  if (!originIataUpper) return "INTERNATIONAL";
  if (CTA_CODES.has(originIataUpper)) return "CTA";
  if (DOMESTIC_CODES.has(originIataUpper)) return "DOMESTIC";
  return "INTERNATIONAL";
}

// ---------- belt allocation helpers ----------

function toMs(t) {
  return (t instanceof Date) ? +t : +new Date(t);
}

function overlapsOrTooClose(a, b, minGapMin) {
  if (!a.start || !a.end || !b.start || !b.end) return false;
  const s1 = toMs(a.start);
  const e1 = toMs(a.end);
  const s2 = toMs(b.start);
  const e2 = toMs(b.end);

  // overlap
  if (s1 < e2 && s2 < e1) return true;

  // tight gap
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

// returns true if belt can take this flight w/out overlap
function canPlaceStrict(flight, belt, usage) {
  const slots = usage[belt] || [];
  for (const slot of slots) {
    if (overlapsOrTooClose(flight, slot.flightRef, MIN_GAP_MIN)) {
      return false;
    }
  }
  return true;
}

// record placement
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

// choose belt that clears earliest (soonest end time)
function pickEarliestClearingBelt(allowedBelts, usage) {
  let bestBelt = allowedBelts[0];
  let bestEnd = Infinity;
  for (const b of allowedBelts) {
    const slots = usage[b];
    if (!slots || slots.length === 0) {
      // totally empty belt = best
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

// Determine allowed belt priorities from flow + load rules
function beltPriorityList(flight) {
  const airlineLower = (flight.airline || "").toLowerCase();
  const isHeavy =
    airlineLower.includes("jet2") ||
    airlineLower.includes("tui") ||
    (typeof flight.pax_estimate === "number" && flight.pax_estimate >= 150);

  if (flight.flow === "DOMESTIC") {
    // Domestic always bag belt 7 only
    return [7];
  }
  if (flight.flow === "CTA") {
    // CTA always bag belt 6 only
    return [6];
  }

  // INTERNATIONAL
  // belt 5 is long and good for heavy loads,
  // but shouldn't be spammed if 1/2/3 are free.
  if (isHeavy) {
    // heavy flights prefer belt 5 first if it's free
    return [5, 1, 2, 3];
  } else {
    // normal international priority
    return [1, 2, 3, 5];
  }
}

// allocate belts across the full flight list
function assignBelts(flights) {
  // sort by ETA (or start) in time order so we "replay" the day
  flights.sort((a, b) => {
    const ta = a.eta ? Date.parse(a.eta) : (a.start ? Date.parse(a.start) : Infinity);
    const tb = b.eta ? Date.parse(b.eta) : (b.start ? Date.parse(b.start) : Infinity);
    return ta - tb;
  });

  const usage = initUsage();

  for (const f of flights) {
    // if something already assigned, keep it
    if (f.belt && BELTS_ALL.includes(parseInt(f.belt, 10))) {
      recordPlacement(f, parseInt(f.belt,10), usage, f.reason || "");
      continue;
    }

    const priorities = beltPriorityList(f);

    // First pass: try strict (no overlap / min gap)
    let placed = false;
    for (const b of priorities) {
      if (canPlaceStrict(f, b, usage)) {
        // pick a sensible reason
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

    // Second pass: everything overlapping → force to earliest-clearing among allowed
    if (!placed) {
      const fb = pickEarliestClearingBelt(priorities, usage);
      let r = f.reason || "stacked";
      if (f.flow === "DOMESTIC") r = "domestic→7";
      else if (f.flow === "CTA") r = "cta→6";
      recordPlacement(f, fb, usage, r);
    }
  }

  return flights;
}

// ---------- parsing FR24 blocks ----------

// remove obvious junk rows like weekday headers etc.
function looksLikeJunk(line0) {
  if (!line0) return false;
  const s = line0.trim().toLowerCase();
  if (
    s.startsWith("monday") ||
    s.startsWith("tuesday") ||
    s.startsWith("wednesday") ||
    s.startsWith("thursday") ||
    s.startsWith("friday") ||
    s.startsWith("saturday") ||
    s.startsWith("sunday")
  ) return true;
  if (s === "loading...") return true;
  if (s.startsWith("sorry, we don't have any information")) return true;
  return false;
}

// Parse "card-style" FR24 rows:
// lines like:
//   0: "Estimated 18:28"
//   1: "18:20"
//   2: "SI4494"
//   3: "Jersey(JER)"
//   4: "AT76"
//   5: "G-ISLP"
//   6: "Blue Islands"
function parseCardStyle(lines) {
  const statusLine    = lines[0] || ""; // "Estimated 18:28"
  const schedLine     = lines[1] || ""; // "18:20"
  const flightLine    = lines[2] || ""; // "SI4494"
  const originLine    = lines[3] || ""; // "Jersey(JER)"
  const aircraftLine  = lines[4] || ""; // "AT76"
  const regOrAirline1 = lines[5] || ""; // "G-ISLP"
  const airlineMaybe  = lines[6] || ""; // "Blue Islands"

  // ETA hh:mm from statusLine
  let etaHHMM = "";
  const mEta = statusLine.match(/(\d{1,2}:\d{2})/);
  if (mEta) etaHHMM = mEta[1];

  const etaIso = etaHHMM ? todayIsoFromHHMM(etaHHMM) : null;

  // start/end = ETA+15 / ETA+45
  const startIso = etaIso ? addMinutesISO(etaIso, 15) : null;
  const endIso   = etaIso ? addMinutesISO(etaIso, 45) : null;

  // extract origin city + IATA
  // e.g. "Jersey(JER)" → city="Jersey", iata="JER"
  let originCity = originLine;
  let originIata = "";
  const mOri = originLine.match(/^(.*)\(([A-Za-z0-9]{2,5})\)/);
  if (mOri) {
    originCity = (mOri[1] || "").trim();
    originIata = (mOri[2] || "").trim().toUpperCase();
  }

  const delay = calcDelayMin(schedLine, etaHHMM);

  const flow = classifyFlow(originIata.toUpperCase());

  // airline / aircraft info for tooltip
  const airline = airlineMaybe || regOrAirline1 || "";
  const aircraft = aircraftLine ? `(${aircraftLine})` : "";

  return {
    flight: flightLine.trim(),
    origin: originIata ? `(${originIata})` : `(${originCity || ""})`,
    origin_iata: originIata.toUpperCase(),
    origin_name: originCity,
    eta: etaIso,
    status: statusLine.toLowerCase(),
    flow,
    belt: "", // assigned later
    start: startIso,
    end: endIso,
    reason: "fr24:live",
    airline,
    aircraft,
    pax_estimate: null,
    scheduled_local: schedLine,
    eta_local: etaHHMM || "",
    delay_min: delay,
    ui_state: "upcoming",
    ui_age_min: 0
  };
}

// Parse fallback single-line style FR24 rows, e.g.
// "00:20 U22916Hurghada (HRG)-easyJet -A20N (G-UZLZ) Estimated 00:26"
function parseFallback(lines) {
  const joined = lines.join(" ").replace(/\s+/g, " ").trim();

  // scheduled time at start
  const mSched = joined.match(/^(\d{1,2}:\d{2})\s+/);
  const schedLocal = mSched ? mSched[1] : "";

  // flight code after scheduled time
  let flightCode = "";
  if (mSched) {
    const restAfterSched = joined.slice(mSched[0].length);
    const mFlight = restAfterSched.match(/^([A-Z]{1,3}\d{2,4})/i);
    if (mFlight) {
      flightCode = mFlight[1].toUpperCase();
    }
  }

  // origin + iata after flight
  // pattern: CITY (IATA)
  let originCity = "";
  let originIata = "";
  const mOrigin = joined.match(/[A-Z]{1,3}\d{2,4}([A-Za-z \-'/]+)\(([A-Z0-9]{2,5})\)/i);
  if (mOrigin) {
    originCity = (mOrigin[1] || "").trim();
    originIata = (mOrigin[2] || "").trim().toUpperCase();
  }

  // airline + aircraft (for tooltip)
  // try to grab "... ) AirlineName -A20N (REG) ..."
  let airline = "";
  let aircraft = "";
  {
    // after the city/icao close paren
    const afterCityIdx = joined.indexOf(")") + 1;
    if (afterCityIdx > 0) {
      const tail = joined.slice(afterCityIdx).trim(); // " -easyJet -A20N (G-UZLZ) Estimated 00:26"
      const mAir = tail.match(/-\s*([^-\(]+?)\s*-/);   // "-easyJet -A20N..."
      if (mAir) {
        airline = mAir[1].trim();
      }
      // grab aircraft + reg like "-A20N (G-UZLZ)"
      const mAc = tail.match(/-\s*([A-Za-z0-9]+)\s*\(([A-Za-z0-9\-]+)\)/);
      if (mAc) {
        aircraft = `(${mAc[1]} ${mAc[2]})`;
      }
    }
  }

  // ETA / status:
  // look for "Estimated 00:26", "Landed 21:23", "Delayed 01:10", etc.
  let statusWord = "";
  let etaLocal = "";
  {
    const mStat = joined.match(/\b(Estimated|Landed|Delayed|Scheduled)\s+(\d{1,2}:\d{2})/i);
    if (mStat) {
      statusWord = mStat[1];
      etaLocal = mStat[2];
    }
  }
  if (!etaLocal && schedLocal) {
    // fallback: assume ETA is sched if FR24 didn't expose an ETA
    etaLocal = schedLocal;
    statusWord = statusWord || "scheduled";
  }

  const statusText = (statusWord ? statusWord.toLowerCase() + " " + etaLocal : "").trim();

  // Turn times into ISO and belt window
  const etaIso = etaLocal ? todayIsoFromHHMM(etaLocal) : null;
  const startIso = etaIso ? addMinutesISO(etaIso, 15) : null;
  const endIso   = etaIso ? addMinutesISO(etaIso, 45) : null;

  const delay = calcDelayMin(schedLocal, etaLocal);
  const flow = classifyFlow(originIata.toUpperCase());

  return {
    flight: flightCode,
    origin: originIata ? `(${originIata})` : "",
    origin_iata: originIata.toUpperCase(),
    origin_name: originCity,
    eta: etaIso,
    status: statusText,
    flow,
    belt: "", // assigned later
    start: startIso,
    end: endIso,
    reason: "fr24:fallback",
    airline,
    aircraft,
    pax_estimate: null,
    scheduled_local: schedLocal,
    eta_local: etaLocal,
    delay_min: delay,
    ui_state: "upcoming",
    ui_age_min: 0
  };
}

// ---------- main scrape ----------

async function main() {
  console.log("[fr24_snap] start…");

  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  const page = await browser.newPage();
  await page.goto(FR24_URL, { waitUntil: "networkidle2", timeout: 60000 });
  await page.waitForSelector("body", { timeout: 60000 }).catch(() => {});

  // pull visible rows
  const rawBlocks = await page.evaluate(() => {
    const out = [];

    // table-style rows
    document.querySelectorAll("table tbody tr, .table tbody tr").forEach(tr => {
      const txt = tr.innerText || tr.textContent || "";
      if (txt.trim()) out.push({ kind: "table", text: txt });
    });

    // card / div rows
    document.querySelectorAll('[role="row"], .row, .list-item, .data-row').forEach(el => {
      const txt = el.innerText || el.textContent || "";
      if (txt.trim()) out.push({ kind: "card", text: txt });
    });

    if (out.length === 0) {
      const txt = document.body.innerText || "";
      out.push({ kind: "body", text: txt });
    }
    return out;
  });

  await browser.close();

  // normalise each block into a flight row
  const rowsRaw = [];

  for (const blk of rawBlocks) {
    const lines = blk.text
      .split("\n")
      .map(s => s.trim())
      .filter(Boolean);

    if (lines.length === 0) continue;
    if (looksLikeJunk(lines[0])) continue;

    // "card" layout (Estimated/Landed/etc first line)
    if (
      lines.length >= 4 &&
      /^(estimated|delayed|landed|scheduled)/i.test(lines[0])
    ) {
      const parsed = parseCardStyle(lines);
      if (parsed.flight) rowsRaw.push(parsed);
      continue;
    }

    // fallback layout (single squashed string)
    const parsedFB = parseFallback(lines);
    if (parsedFB.flight) {
      rowsRaw.push(parsedFB);
    }
  }

  // filter: within 3h horizon, and drop nonsense
  const now = new Date();
  const horizonMs = now.getTime() + HORIZON_MIN * 60000;

  const filtered = rowsRaw.filter(r => {
    if (!r.flight || !r.flight.trim()) return false;
    // keep only arrivals within horizon (based on ETA or start)
    const t = r.eta
      ? new Date(r.eta).getTime()
      : r.start
      ? new Date(r.start).getTime()
      : null;
    if (t == null) return true;
    return t <= horizonMs;
  });

  // allocate belts using rules (CTA→6, DOMESTIC→7, etc.)
  const withBelts = assignBelts(filtered);

  const outJson = {
    generated_at_utc: now.toISOString(),
    generated_at_local: now.toISOString(),
    source: "flightradar24.com (live screen-scrape)",
    horizon_minutes: HORIZON_MIN,
    rows: withBelts
  };

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(outJson, null, 2), "utf8");
  console.log(`[fr24_snap] wrote ${withBelts.length} rows to ${OUTPUT_PATH}.`);
}

main().catch(err => {
  console.error("[fr24_snap] ERROR:", err);
  process.exit(1);
});
