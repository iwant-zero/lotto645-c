// scripts/update_lotto645.mjs
// Node 20+ (built-in fetch)
//
// Robust updater with multi-source fallback (2~3+ backends):
// 1) smok95 GitHub Pages
// 2) raw.githubusercontent.com (same data, different infra)
// 3) jsDelivr CDN (same repo path, CDN infra)
// If all "all.json" fail: try incremental update using latest + per-draw json.
// If even that fails but existing local draws exist: regenerate freq and exit 0 (keep Pages alive).

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const DRAWS_PATH = path.join(DATA_DIR, "lotto645_draws.json");
const FREQ_PATH = path.join(DATA_DIR, "lotto645_freq.json");

const SOURCES = [
  {
    id: "smok95-pages",
    allUrls: ["https://smok95.github.io/lotto/results/all.json"],
    latestUrls: ["https://smok95.github.io/lotto/results/latest.json"],
    drawUrl: (n) => `https://smok95.github.io/lotto/results/${n}.json`,
  },
  {
    id: "smok95-raw",
    allUrls: ["https://raw.githubusercontent.com/smok95/lotto/main/results/all.json"],
    latestUrls: ["https://raw.githubusercontent.com/smok95/lotto/main/results/latest.json"],
    drawUrl: (n) => `https://raw.githubusercontent.com/smok95/lotto/main/results/${n}.json`,
  },
  {
    id: "smok95-jsdelivr",
    // NOTE: jsDelivr usually supports GitHub repo assets as CDN
    allUrls: ["https://cdn.jsdelivr.net/gh/smok95/lotto@main/results/all.json"],
    latestUrls: ["https://cdn.jsdelivr.net/gh/smok95/lotto@main/results/latest.json"],
    drawUrl: (n) => `https://cdn.jsdelivr.net/gh/smok95/lotto@main/results/${n}.json`,
  },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function readJsonSafe(p, fallback) {
  try {
    const s = await fs.readFile(p, "utf-8");
    return JSON.parse(s);
  } catch {
    return fallback;
  }
}

async function writeJson(p, obj) {
  const s = JSON.stringify(obj, null, 2);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, s, "utf-8");
}

function isHtmlLike(text) {
  const t = (text || "").trimStart();
  return (
    t.startsWith("<!DOCTYPE") ||
    t.startsWith("<html") ||
    t.startsWith("<head") ||
    t.startsWith("<body") ||
    t.startsWith("<")
  );
}

async function fetchTextWithTimeout(url, ms = 25000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: "follow",
      headers: {
        "user-agent": "github-actions-lotto645-updater/3.0",
        accept: "application/json,text/plain,*/*",
      },
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}\n${text.slice(0, 200)}`);
    }
    return text;
  } finally {
    clearTimeout(t);
  }
}

async function fetchJsonGuarded(url, retries = 2) {
  let lastErr = null;
  for (let i = 0; i <= retries; i++) {
    try {
      const text = await fetchTextWithTimeout(url, 25000 + i * 5000);
      if (isHtmlLike(text)) {
        throw new Error(`Expected JSON but got HTML from ${url}\n${text.trimStart().slice(0, 180)}`);
      }
      return JSON.parse(text);
    } catch (e) {
      lastErr = e;
      if (i < retries) await sleep(400 + i * 600);
    }
  }
  throw lastErr;
}

function toYmd(isoOrYmd) {
  if (!isoOrYmd) return null;
  const s = String(isoOrYmd);
  return s.length >= 10 ? s.slice(0, 10) : s;
}

function normalizeDrawFromSmok(item) {
  // smok95 format:
  // { draw_no, numbers:[..], bonus_no, date:"YYYY-MM-DDT00:00:00Z", ... }
  const drwNo = Number(item?.draw_no);
  const nums = Array.isArray(item?.numbers) ? item.numbers.map(Number) : [];
  const bonus = Number(item?.bonus_no);
  const date = toYmd(item?.date);

  if (!Number.isFinite(drwNo) || nums.length !== 6 || !date) return null;

  const sorted = nums.slice().sort((a, b) => a - b);
  return { drwNo, date, numbers: sorted, bonus };
}

function initCounter() {
  const c = {};
  for (let i = 1; i <= 45; i++) c[i] = 0;
  return c;
}

function addCount(counter, n, w = 1) {
  if (n >= 1 && n <= 45) counter[n] += w;
}

function makeFreq(draws) {
  const overallMain = initCounter();
  const overallBonus = initCounter();

  for (const d of draws) {
    for (const n of d.numbers) addCount(overallMain, n, 1);
    addCount(overallBonus, d.bonus, 1);
  }

  const windows = [10, 20, 30];
  const recent = {};

  for (const n of windows) {
    const slice = draws.slice(-n);
    const main = initCounter();
    const bonus = initCounter();

    for (const d of slice) {
      for (const x of d.numbers) addCount(main, x, 1);
      addCount(bonus, d.bonus, 1);
    }

    const from = slice.length ? slice[0].date : null;
    const to = slice.length ? slice[slice.length - 1].date : null;

    recent[String(n)] = {
      from,
      to,
      drawCount: slice.length,
      main,
      bonus,
    };
  }

  return { overall: { main: overallMain, bonus: overallBonus }, recent };
}

function mergeByNo(existingDraws, newDraws) {
  const m = new Map();
  for (const d of existingDraws || []) {
    if (d && Number.isFinite(Number(d.drwNo))) m.set(Number(d.drwNo), d);
  }
  for (const d of newDraws || []) {
    if (d && Number.isFinite(Number(d.drwNo))) m.set(Number(d.drwNo), d);
  }
  return [...m.values()].sort((a, b) => a.drwNo - b.drwNo);
}

async function tryFetchAllFromSource(src) {
  for (const url of src.allUrls) {
    const json = await fetchJsonGuarded(url, 2);
    if (!Array.isArray(json) || json.length === 0) {
      throw new Error(`[${src.id}] all.json is not a non-empty array: ${url}`);
    }
    const mapped = [];
    for (const it of json) {
      const d = normalizeDrawFromSmok(it);
      if (d) mapped.push(d);
    }
    if (!mapped.length) {
      throw new Error(`[${src.id}] parsed 0 valid draws from: ${url}`);
    }
    mapped.sort((a, b) => a.drwNo - b.drwNo);
    return { draws: mapped, usedUrl: url };
  }
  throw new Error(`[${src.id}] no allUrls worked`);
}

async function tryFetchLatestNoFromSource(src) {
  for (const url of src.latestUrls) {
    const obj = await fetchJsonGuarded(url, 2);
    const n = Number(obj?.draw_no);
    if (Number.isFinite(n) && n > 0) return { latestNo: n, usedUrl: url };
  }
  throw new Error(`[${src.id}] no latestUrls worked`);
}

async function tryFetchOneDrawAcrossSources(drawNo) {
  let lastErr = null;
  for (const src of SOURCES) {
    const url = src.drawUrl(drawNo);
    try {
      const obj = await fetchJsonGuarded(url, 2);
      const d = normalizeDrawFromSmok(obj);
      if (d) return { draw: d, sourceId: src.id, usedUrl: url };
      lastErr = new Error(`[${src.id}] draw json invalid: ${url}`);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error(`Failed to fetch draw ${drawNo}`);
}

async function main() {
  await fs.mkdir(DATA_DIR, { recursive: true });

  const existing = await readJsonSafe(DRAWS_PATH, []);
  const existingLastNo =
    existing.length > 0
      ? Math.max(...existing.map((d) => Number(d?.drwNo)).filter(Number.isFinite))
      : 0;

  console.log(`[lotto645] existing draws=${existing.length}, lastNo=${existingLastNo}`);

  // 1) Try "all.json" with automatic fallback
  let used = {
    mode: "all.json",
    sourceId: null,
    url: null,
    attempts: SOURCES.map((s) => s.id),
  };

  let draws = null;

  for (const src of SOURCES) {
    try {
      console.log(`[lotto645] try all.json from ${src.id} ...`);
      const got = await tryFetchAllFromSource(src);
      draws = got.draws;
      used.sourceId = src.id;
      used.url = got.usedUrl;
      console.log(`[lotto645] success all.json via ${src.id}`);
      break;
    } catch (e) {
      console.warn(`[lotto645] failed all.json via ${src.id}: ${e?.message || e}`);
    }
  }

  // 2) If all.json failed, try incremental update using latest + per-draw json
  if (!draws) {
    used.mode = "incremental";
    console.warn("[lotto645] all sources failed for all.json. Trying incremental update...");

    let latestNo = 0;
    let latestFrom = null;

    for (const src of SOURCES) {
      try {
        console.log(`[lotto645] try latest.json from ${src.id} ...`);
        const got = await tryFetchLatestNoFromSource(src);
        latestNo = got.latestNo;
        latestFrom = { sourceId: src.id, url: got.usedUrl };
        console.log(`[lotto645] latestNo=${latestNo} via ${src.id}`);
        break;
      } catch (e) {
        console.warn(`[lotto645] failed latest.json via ${src.id}: ${e?.message || e}`);
      }
    }

    if (latestNo > 0 && existingLastNo > 0 && latestNo >= existingLastNo) {
      let merged = existing.slice();
      let fetchedCount = 0;

      for (let n = existingLastNo + 1; n <= latestNo; n++) {
        try {
          const got = await tryFetchOneDrawAcrossSources(n);
          merged = mergeByNo(merged, [got.draw]);
          fetchedCount++;
          console.log(`[lotto645] fetched draw ${n} via ${got.sourceId}`);
        } catch (e) {
          console.warn(`[lotto645] failed fetch draw ${n}: ${e?.message || e}`);
          // stop early: better keep old data than fail job
          break;
        }
      }

      draws = merged;
      used.sourceId = latestFrom?.sourceId || "unknown";
      used.url = latestFrom?.url || null;
      used.note = `incremental fetched=${fetchedCount}, latestNo=${latestNo}`;
    } else {
      // If we can't incrementally update, fall back to existing data (keep Actions green)
      if (existing.length > 0) {
        draws = existing;
        used.mode = "local-only";
        used.sourceId = "local-cache";
        used.note =
          latestNo > 0
            ? `latestNo=${latestNo}, but existingLastNo=${existingLastNo} (or missing). Using local cache.`
            : "cannot determine latestNo. Using local cache.";
      }
    }
  }

  if (!draws || draws.length === 0) {
    throw new Error("No draws available (all sources failed and no local cache).");
  }

  draws.sort((a, b) => a.drwNo - b.drwNo);
  const last = draws[draws.length - 1];

  const freq = makeFreq(draws);

  const payloadFreq = {
    updatedAt: new Date().toISOString(),
    source: {
      primary: used.sourceId,
      mode: used.mode,
      usedUrl: used.url,
      attempts: used.attempts,
      note:
        used.note ||
        "Multi-source fallback: pages -> raw -> jsdelivr. If remote fetch fails, uses local cache to avoid Actions failure.",
      endpoints: {
        pages: {
          latest: "https://smok95.github.io/lotto/results/latest.json",
          all: "https://smok95.github.io/lotto/results/all.json",
        },
        raw: {
          latest: "https://raw.githubusercontent.com/smok95/lotto/main/results/latest.json",
          all: "https://raw.githubusercontent.com/smok95/lotto/main/results/all.json",
        },
        jsdelivr: {
          latest: "https://cdn.jsdelivr.net/gh/smok95/lotto@main/results/latest.json",
          all: "https://cdn.jsdelivr.net/gh/smok95/lotto@main/results/all.json",
        },
      },
    },
    lastDraw: {
      drwNo: last.drwNo,
      date: last.date,
      numbers: last.numbers,
      bonus: last.bonus,
    },
    totalDraws: draws.length,
    overall: freq.overall,
    recent: freq.recent, // "10" | "20" | "30"
  };

  // Always write draws + freq (even if local-only) so Pages keeps running
  await writeJson(DRAWS_PATH, draws);
  await writeJson(FREQ_PATH, payloadFreq);

  console.log(`[lotto645] wrote draws=${draws.length}`);
  console.log(`[lotto645] lastDraw=${last.drwNo} (${last.date})`);
  console.log(`[lotto645] mode=${used.mode}, source=${used.sourceId}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
