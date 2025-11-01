// feeder/fr24_snap.js
//
// STEP 1: scrape live FR24 â†’ rough arrivals list for BRS
// OUTPUT: docs/assignments.json (raw arrivals, BEFORE belt allocation)
//
// This script:
//  - visits FR24 arrivals
//  - tries to normalise each arrival row
//  - builds 3h horizon
//  - gives each row the structure we expect on the front-end
//
// NOTE
//  - Belt, flow etc will be finalised by fr24_feeder.js (step 2)

import fs from "fs";
import path from "path";
import puppeteer from "puppeteer";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const OUTPUT_PATH = path.join(__dirname, "..", "docs", "assignments.json");
const FR24_URL = "https://www.flightradar24.com/data/airports/brs/arrivals";

const HORIZON_MIN = 180;               // only keep ~3h ahead
const BELT_START_OFFSET_MIN = 15;      // belt opens 15 min after ETA
const BELT_TOTAL_WINDOW_MIN = 45;      // belt closes 45 min after ETA (so ~30 min after start)

// ---------- helpers ----------

function addMinutesIso(iso, mins) {
  if (!iso) return null;
  const d = new Date(iso);
  return new Date(d.getTime() + mins * 60000).toISOString();
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

function extractIataFromOrigin(originText) {
  // "Antalya(AYT)" or "Antalya (AYT)" or "(CPH)"
  if (!originText) return "";
  const m = originText.match(/\(([A-Za-z0-9]{2,5})\)/);
  return m ? m[1].toUpperCase() : "";
}

function calcDelayMin(schedHHMM, etaHHMM) {
  // positive = late, negative = early
  if (!schedHHMM || !etaHHMM) return null;
  const now = new Date();

  const [sh, sm] = schedHHMM.split(":").map(Number);
  const [eh, em] = etaHHMM.split(":").map(Number);

  const sched = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    sh,
    sm,
    0,
    0
  );
  const eta = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    eh,
    em,
    0,
    0
  );

  return Math.round((eta - sched) / 60000);
}

function looksLikeJunk(firstLine) {
  if (!firstLine) return false;
  const s = firstLine.trim().toLowerCase();
  if (
    s.startsWith("monday") ||
    s.startsWith("tuesday") ||
    s.startsWith("wednesday") ||
    s.startsWith("thursday") ||
    s.startsWith("friday") ||
    s.startsWith("saturday") ||
    s.startsWith("sunday")
  ) {
    return true;
  }
  if (s === "loading...") return true;
  if (s.startsWith("sorry, we don't have any information")) return true;
  return false;
}

// pattern A (multi-line block like FR24 "card"):
//   0: "Estimated 18:28" / "Landed 21:23" / "Scheduled 07:10"
//   1: "18:20"            (scheduled)
//   2: "SI4494"           (flight code)
//   3: "Jersey(JER)"      (origin + IATA)
//   4: "AT76"             (aircraft type)
//   5: "G-ISLP"           (reg)  [sometimes line 5 exists]
//   6: "Blue Islands"     (airline) [or line 6 may shift]
// We convert it into our row object.
function parsePatternA(lines) {
  const statusLine = lines[0] || "";
  const schedLocal = lines[1] || "";
  const flightCode = lines[2] || "";
  const originLine = lines[3] || "";
  const aircraftGuess = lines[4] || "";
  const airlineGuess = lines[6] || lines[5] || "";

  // ETA local from status line, e.g. "estimated 18:28"
  let etaHHMM = "";
  const mEta = statusLine.match(/(\d{1,2}:\d{2})/);
  if (mEta) {
    etaHHMM = mEta[1];
  }

  const etaIso = etaHHMM ? todayIsoFromHHMM(etaHHMM) : null;

  // belt timing windows (start 15 min after ETA, end 45 min after ETA)
  const startIso = addMinutesIso(etaIso, BELT_START_OFFSET_MIN);
  const endIso = addMinutesIso(etaIso, BELT_TOTAL_WINDOW_MIN);

  return {
    flight: flightCode.trim(),
    origin: originLine.trim(),
    origin_iata: extractIataFromOrigin(originLine),
    eta: etaIso,
    status: statusLine.toLowerCase().trim(), // "estimated 18:28"
    flow: "", // will be set later by feeder
    belt: "", // will be set later by feeder
    start: startIso,
    end: endIso,
    reason: "fr24:live",
    airline: (airlineGuess || "").trim(),
    aircraft: aircraftGuess ? `(${aircraftGuess.trim()})` : "",
    pax_estimate: null,
    scheduled_local: schedLocal || "",
    eta_local: etaHHMM || "",
    delay_min: calcDelayMin(schedLocal, etaHHMM),
    ui_state: "upcoming",
    ui_age_min: 0,
  };
}

// pattern B (FR24 collapsed into one noisy line). Example you showed:
//
// "00:20 U22916Hurghada (HRG)-easyJet -A20N (G-UZLZ) Estimated 00:26"
//
// We want:
//   scheduled_local: "00:20"
//   flight: "U22916"
//   origin: "Hurghada (HRG)"
//   eta_local: "00:26"
//   status: "estimated 00:26"
function parsePatternB(lines) {
  // merge lines because FR24 sometimes shoves everything into the first line
  const raw = lines.join(" ").replace(/\s+/g, " ").trim();
  if (!raw) return null;

  // 1) time, flight, then rest
  //    HH:MM  U22916  Hurghada (HRG)-easyJet...
  const m = raw.match(
    /^(\d{1,2}:\d{2})\s+([A-Z]{1,3}\d{2,4})\s+(.+)$/i
  );
  if (!m) return null;

  const schedLocal = m[1]; // "00:20"
  const flightCode = m[2].toUpperCase(); // "U22916"
  let rest = m[3].trim(); // "Hurghada (HRG)-easyJet ... Estimated 00:26"

  // origin chunk "Hurghada (HRG)" -> grab up to first ) after "(XXX)"
  let originFull = "";
  let originIata = "";
  const mOrigin = rest.match(/^(.+?\(([A-Za-z0-9]{2,5})\))/);
  if (mOrigin) {
    originFull = mOrigin[1].trim(); // "Hurghada (HRG)"
    originIata = (mOrigin[2] || "").toUpperCase();
    rest = rest.slice(mOrigin[0].length).trim();
  }

  // find ETA in the tail e.g. "Estimated 00:26"
  let etaHHMM = "";
  let statusLower = "";
  const mETA2 = rest.match(
    /(estimated|landed|delayed|scheduled)\s+(\d{1,2}:\d{2})/i
  );
  if (mETA2) {
    statusLower =
      mETA2[1].toLowerCase() + " " + mETA2[2];
    etaHHMM = mETA2[2];
  } else {
    // fallback to scheduled time
    statusLower = "scheduled";
    etaHHMM = schedLocal;
  }

  const etaIso = etaHHMM ? todayIsoFromHHMM(etaHHMM) : null;
  const startIso = addMinutesIso(etaIso, BELT_START_OFFSET_MIN);
  const endIso = addMinutesIso(etaIso, BELT_TOTAL_WINDOW_MIN);

  // airline guess = first token left in "rest"
  const airlineGuess = rest.split(/\s+/)[0] || "";

  return {
    flight: flightCode,
    origin: originFull || originIata || "",
    origin_iata: originIata,
    eta: etaIso,
    status: statusLower,
    flow: "",
    belt: "",
    start: startIso,
    end: endIso,
    reason: "fr24:fallback",
    airline: airlineGuess,
    aircraft: "",
    pax_estimate: null,
    scheduled_local: schedLocal,
    eta_local: etaHHMM || "",
    delay_min: calcDelayMin(schedLocal, etaHHMM),
    ui_state: "upcoming",
    ui_age_min: 0,
  };
}

async function main() {
  console.log("[fr24_snap] start scrapeâ€¦");

  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  const page = await browser.newPage();
  await page.goto(FR24_URL, {
    waitUntil: "networkidle2",
    timeout: 60000,
  });
  await page
    .waitForSelector("body", { timeout: 60000 })
    .catch(() => {});

  // Pull a bunch of row-like elements from the DOM
  const rawBlocks = await page.evaluate(() => {
    const out = [];

    // legacy tables
    document
      .querySelectorAll("table tbody tr, .table tbody tr")
      .forEach((tr) => {
        const txt = tr.innerText || tr.textContent || "";
        if (txt.trim()) {
          out.push({
            kind: "table",
            text: txt,
          });
        }
      });

    // newer card/list style
    document
      .querySelectorAll(
        '[role="row"], .row, .list-item, .data-row'
      )
      .forEach((el) => {
        const txt = el.innerText || el.textContent || "";
        if (txt.trim()) {
          out.push({
            kind: "card",
            text: txt,
          });
        }
      });

    // fallback whole page
    if (out.length === 0) {
      const txt = document.body.innerText || "";
      out.push({ kind: "body", text: txt });
    }

    return out;
  });

  await browser.close();

  // parse -> rows[]
  const parsedRows = [];

  for (const blk of rawBlocks) {
    const lines = blk.text
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);

    if (!lines.length) continue;
    if (looksLikeJunk(lines[0])) continue;

    let row = null;

    // try pattern A
    if (
      lines.length >= 4 &&
      /^(estimated|delayed|landed|scheduled)/i.test(lines[0])
    ) {
      row = parsePatternA(lines);
    }

    // fallback pattern B
    if (!row) {
      row = parsePatternB(lines);
    }

    if (row && row.flight) {
      parsedRows.push(row);
    }
  }

  // dedupe same flight+ETA
  const dedup = new Map();
  for (const r of parsedRows) {
    const key = `${r.flight}|${r.eta_local || ""}`;
    if (!dedup.has(key)) {
      dedup.set(key, r);
    }
  }
  let rows = Array.from(dedup.values());

  // horizon filter: only keep arrivals within next 3h if we have ETA
  const now = new Date();
  const cutoffMs = now.getTime() + HORIZON_MIN * 60000;
  rows = rows.filter((r) => {
    if (!r.eta) return true; // keep if no ETA yet
    const t = new Date(r.eta).getTime();
    return t <= cutoffMs;
  });

  // final sort by start time
  rows.sort((a, b) => {
    const ta = a.start ? +new Date(a.start) : Infinity;
    const tb = b.start ? +new Date(b.start) : Infinity;
    return ta - tb;
  });

  // write file
  const outJson = {
    generated_at_utc: now.toISOString(),
    generated_at_local: now.toISOString(),
    source: "flightradar24.com (live screen-scrape)",
    horizon_minutes: HORIZON_MIN,
    rows,
  };

  fs.writeFileSync(
    OUTPUT_PATH,
    JSON.stringify(outJson, null, 2),
    "utf8"
  );

  console.log(
    `[fr24_snap] wrote ${rows.length} rows to ${OUTPUT_PATH}.`
  );
}

main().catch((err) => {
  console.error("[fr24_snap] ERROR:", err);
  process.exit(1);
});

