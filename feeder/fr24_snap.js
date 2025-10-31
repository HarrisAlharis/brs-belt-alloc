// feeder/fr24_snap.js
//
// PURPOSE
// - Open FR24 BRS arrivals
// - Read the current "cards/table-like" layout (the one that gives text like:
//     "Estimated 18:28\n 18:20\n SI4494\n Jersey(JER)\n AT76\nG-ISLP\nBlue Islands")
// - Turn each real flight into a proper row our feeder understands
// - Write to docs/assignments.json (RAW, BEFORE belt logic)
//
// REQUIREMENTS
// - Node 18+
// - npm i puppeteer
//
// NOTE
// - Repo is "type": "module", so we use ESM imports.

import fs from "fs";
import path from "path";
import puppeteer from "puppeteer";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const OUTPUT_PATH = path.join(__dirname, "..", "docs", "assignments.json");
const FR24_URL = "https://www.flightradar24.com/data/airports/brs/arrivals";

// 30 minutes default belt window
const DEFAULT_BELT_MIN = 30;

// turn "18:28" into today ISO
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

// extract "(CPH)" → "CPH"
function extractIataFromOrigin(origin) {
  if (!origin) return "";
  const m = origin.match(/\(([A-Za-z0-9]{2,5})\)/);
  return m ? m[1].toUpperCase() : "";
}

// very simple filter for junk rows like "Friday, Oct 31"
function looksLikeJunk(title) {
  if (!title) return false;
  const s = title.trim().toLowerCase();
  if (s.startsWith("friday") || s.startsWith("saturday") || s.startsWith("sunday") || s.startsWith("monday") ||
      s.startsWith("tuesday") || s.startsWith("wednesday") || s.startsWith("thursday")) {
    return true;
  }
  if (s === "loading...") return true;
  if (s.startsWith("sorry, we don't have any information")) return true;
  return false;
}

async function main() {
  console.log("[fr24_snap] starting…");

  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  const page = await browser.newPage();
  await page.goto(FR24_URL, { waitUntil: "networkidle2", timeout: 60000 });

  // try to wait for something list-like
  await page.waitForSelector("body", { timeout: 60000 }).catch(() => {});

  // run in page
  const rawRows = await page.evaluate(() => {
    const out = [];

    // strategy:
    // 1) grab all <tr> rows (old style)
    // 2) also grab all elements that look like list items for FR24's new UI
    //    and parse their innerText lines
    //
    // we push everything, we'll filter in Node side

    // old tables
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

    // new cards (div-based)
    // we look for anything with role=row or data-id on arrivals list
    document
      .querySelectorAll('[role="row"], .row, .list-item, .data-row')
      .forEach((el) => {
        const txt = el.innerText || el.textContent || "";
        if (txt.trim()) {
          out.push({
            kind: "card",
            text: txt,
          });
        }
      });

    // fallback: if we found nothing, just take body text
    if (out.length === 0) {
      const txt = document.body.innerText || "";
      out.push({ kind: "body", text: txt });
    }

    return out;
  });

  await browser.close();

  // --------------------------------------------------
  // PARSE BLOCKS
  // --------------------------------------------------
  const rows = [];

  for (const blk of rawRows) {
    // split per line
    const lines = blk.text
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);

    if (lines.length === 0) continue;

    // FR24 current layout you showed looks like:
    // 0: "Estimated 18:28"   (status + ETA)
    // 1: "18:20"             (scheduled)
    // 2: "SI4494"            (flight)
    // 3: "Jersey(JER)"       (origin)
    // 4: "AT76"              (aircraft)
    // 5: "G-ISLP"            (reg)
    // 6: "Blue Islands"      (airline)
    //
    // but there are also junk lines like "Friday, Oct 31"
    //
    const first = lines[0];

    // drop junk
    if (looksLikeJunk(first)) {
      continue;
    }

    // detect the "new" FR24 pattern by length
    if (
      lines.length >= 4 &&
      /^(estimated|delayed|landed|scheduled)/i.test(lines[0])
    ) {
      const statusLine = lines[0]; // "Estimated 18:28"
      const schedLine = lines[1] || ""; // "18:20"
      const flightLine = lines[2] || ""; // "SI4494"
      const originLine = lines[3] || ""; // "Jersey(JER)"
      const aircraftLine = lines[4] || ""; // "AT76"
      const regLine = lines[5] || "";
      const airlineLine = lines[6] || "";

      // get eta from status
      let etaHHMM = "";
      const mEta = statusLine.match(/(\d{1,2}:\d{2})/);
      if (mEta) {
        etaHHMM = mEta[1];
      }

      const etaIso = etaHHMM ? todayIsoFromHHMM(etaHHMM) : null;
      const startIso = etaIso;
      let endIso = null;
      if (startIso) {
        const s = new Date(startIso);
        endIso = new Date(s.getTime() + DEFAULT_BELT_MIN * 60000).toISOString();
      }

      rows.push({
        flight: flightLine,
        origin: originLine,
        origin_iata: extractIataFromOrigin(originLine),
        eta: etaIso,
        status: statusLine.toLowerCase(),
        flow: "", // to be set by feeder
        belt: "", // to be set by feeder
        start: startIso,
        end: endIso,
        reason: "fr24:live",
        airline: airlineLine,
        aircraft: aircraftLine ? `(${aircraftLine})` : "",
        pax_estimate: null,
        scheduled_local: schedLine,
        eta_local: etaHHMM || "",
        delay_min: calcDelayMin(schedLine, etaHHMM),
        ui_state: "upcoming",
        ui_age_min: 0,
      });

      continue;
    }

    // fallback: try to find something flight-like in generic rows
    const maybeFlight = lines.find((x) => /[A-Za-z]{1,3}\d{2,4}/.test(x));
    if (maybeFlight) {
      const schedLine =
        lines.find((x) => /^\d{1,2}:\d{2}$/.test(x)) || "";
      const originLine =
        lines.find((x) => /\([A-Za-z0-9]{2,5}\)/.test(x)) || "";
      const statusLine =
        lines.find((x) =>
          /estimated|delayed|landed|scheduled/i.test(x)
        ) || "scheduled";

      const etaHHMM =
        (statusLine.match(/(\d{1,2}:\d{2})/) || [null, ""])[1] || "";
      const etaIso = etaHHMM ? todayIsoFromHHMM(etaHHMM) : null;
      const startIso = etaIso;
      let endIso = null;
      if (startIso) {
        const s = new Date(startIso);
        endIso = new Date(s.getTime() + DEFAULT_BELT_MIN * 60000).toISOString();
      }

      rows.push({
        flight: maybeFlight,
        origin: originLine,
        origin_iata: extractIataFromOrigin(originLine),
        eta: etaIso,
        status: statusLine.toLowerCase(),
        flow: "",
        belt: "",
        start: startIso,
        end: endIso,
        reason: "fr24:fallback",
        airline: "",
        aircraft: "",
        pax_estimate: null,
        scheduled_local: schedLine,
        eta_local: etaHHMM || "",
        delay_min: calcDelayMin(schedLine, etaHHMM),
        ui_state: "upcoming",
        ui_age_min: 0,
      });
    }
  }

  const now = new Date();
  const outJson = {
    generated_at_utc: now.toISOString(),
    generated_at_local: now.toISOString(),
    source: "flightradar24.com (live screen-scrape)",
    horizon_minutes: 180,
    rows,
  };

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(outJson, null, 2), "utf8");
  console.log(
    `[fr24_snap] wrote ${rows.length} rows to ${OUTPUT_PATH} (cleaned).`
  );
}

// delay = ETA - scheduled
function calcDelayMin(schedHHMM, etaHHMM) {
  if (!schedHHMM || !etaHHMM) return null;
  const n = new Date();
  const [sh, sm] = schedHHMM.split(":").map(Number);
  const [eh, em] = etaHHMM.split(":").map(Number);
  const s = new Date(n.getFullYear(), n.getMonth(), n.getDate(), sh, sm, 0, 0);
  const e = new Date(n.getFullYear(), n.getMonth(), n.getDate(), eh, em, 0, 0);
  return Math.round((e - s) / 60000);
}

main().catch((err) => {
  console.error("[fr24_snap] ERROR:", err);
  process.exit(1);
});
