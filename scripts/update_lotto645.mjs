// scripts/update_lotto645.mjs
// Node 20+ (built-in fetch)
//
// Fix: dhlottery API often returns HTML (queue/blocked) from GitHub Actions IPs,
// causing "Unexpected token '<'". Use a stable public JSON mirror instead.
// Source: https://smok95.github.io/lotto/results/all.json , latest.json
//
// Outputs:
// - data/lotto645_draws.json (simplified draws list)
// - data/lotto645_freq.json  (overall + recent(last N draws: 10/20/30))

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const DRAWS_PATH = path.join(DATA_DIR, "lotto645_draws.json");
const FREQ_PATH = path.join(DATA_DIR, "lotto645_freq.json");

// Public JSON mirror (GitHub Pages)
const SMOK_BASE = "https://smok95.github.io/lotto/results";
const SMOK_ALL = `${SMOK_BASE}/all.json`;
const SMOK_LATEST = `${SMOK_BASE}/latest.json`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function writeJson(p, obj) {
  const s = JSON.stringify(obj, null, 2);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, s, "utf-8");
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

  // recent N draws
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

async function fetchTextWithTimeout(url, ms = 20000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        // GitHub Pages는 대체로 필요없지만, 안정성을 위해
        "user-agent": "github-actions-lotto645-updater/2.0",
        accept: "application/json,text/plain,*/*",
      },
      redirect: "follow",
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

async function fetchJsonGuarded(url) {
  // 일부 환경에서 JSON 대신 HTML이 올 수 있어 텍스트로 받고 직접 파싱
  const text = await fetchTextWithTimeout(url, 25000);
  const trimmed = text.trimStart();
  if (trimmed.startsWith("<!DOCTYPE") || trimmed.startsWith("<html") || trimmed.startsWith("<")) {
    throw new Error(`Expected JSON but got HTML from ${url}\n${trimmed.slice(0, 180)}`);
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`JSON parse failed from ${url}: ${e?.message || e}`);
  }
}

function toYmd(isoOrYmd) {
  // "2026-02-21T00:00:00Z" -> "2026-02-21"
  if (!isoOrYmd) return null;
  const s = String(isoOrYmd);
  return s.length >= 10 ? s.slice(0, 10) : s;
}

function normalizeDrawFromSmok(item) {
  // smok95 format:
  // { draw_no, numbers:[..], bonus_no, date:"YYYY-MM-DDT00:00:00Z", ... }
  const drwNo = Number(item.draw_no);
  const nums = Array.isArray(item.numbers) ? item.numbers.map(Number) : [];
  const bonus = Number(item.bonus_no);
  const date = toYmd(item.date);

  if (!Number.isFinite(drwNo) || nums.length !== 6 || !date) return null;
  const sorted = nums.slice().sort((a, b) => a - b);

  return { drwNo, date, numbers: sorted, bonus };
}

async function main() {
  await fs.mkdir(DATA_DIR, { recursive: true });

  console.log(`[lotto645] fetching: ${SMOK_LATEST}`);
  const latest = await fetchJsonGuarded(SMOK_LATEST);
  const latestNo = Number(latest?.draw_no);
  console.log(`[lotto645] latest draw_no=${latestNo}`);

  console.log(`[lotto645] fetching: ${SMOK_ALL}`);
  // retry a couple times for network flakiness
  let all = null;
  for (let i = 0; i < 3; i++) {
    try {
      all = await fetchJsonGuarded(SMOK_ALL);
      break;
    } catch (e) {
      if (i === 2) throw e;
      await sleep(500 + i * 500);
    }
  }

  if (!Array.isArray(all) || all.length === 0) {
    throw new Error("SMOK_ALL returned empty/non-array JSON");
  }

  const mapped = [];
  for (const it of all) {
    const d = normalizeDrawFromSmok(it);
    if (d) mapped.push(d);
  }

  if (!mapped.length) throw new Error("No valid draws parsed from SMOK_ALL");

  mapped.sort((a, b) => a.drwNo - b.drwNo);

  // if latest.json says a newer draw exists, ensure we have it
  const last = mapped[mapped.length - 1];
  if (Number.isFinite(latestNo) && last.drwNo < latestNo) {
    console.warn(
      `[lotto645] Warning: all.json last=${last.drwNo} < latest=${latestNo}. ` +
      `Mirror may be updating. Proceeding with last=${last.drwNo}.`
    );
  }

  const freq = makeFreq(mapped);

  const payloadFreq = {
    updatedAt: new Date().toISOString(),
    source: {
      primary: "smok95.github.io",
      endpoints: {
        latest: SMOK_LATEST,
        all: SMOK_ALL,
      },
      note:
        "Using public JSON mirror because dhlottery often returns HTML (queue/blocked) from GitHub-hosted runners.",
    },
    lastDraw: {
      drwNo: last.drwNo,
      date: last.date,
      numbers: last.numbers,
      bonus: last.bonus,
    },
    totalDraws: mapped.length,
    overall: freq.overall,
    recent: freq.recent, // keys: "10" | "20" | "30"
  };

  await writeJson(DRAWS_PATH, mapped);
  await writeJson(FREQ_PATH, payloadFreq);

  console.log(`[lotto645] wrote draws=${mapped.length}`);
  console.log(`[lotto645] lastDraw=${last.drwNo} (${last.date})`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
