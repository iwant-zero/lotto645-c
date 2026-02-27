// scripts/update_lotto645.mjs
// Node 20+ (built-in fetch)
// Updates:
// - data/lotto645_draws.json (all draws)
// - data/lotto645_freq.json  (overall + recent(last N draws: 10/20/30))

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const DRAWS_PATH = path.join(DATA_DIR, "lotto645_draws.json");
const FREQ_PATH = path.join(DATA_DIR, "lotto645_freq.json");

// Widely used JSON endpoint
const ENDPOINT = "https://www.dhlottery.co.kr/common.do?method=getLottoNumber&drwNo=";

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

function isSuccess(data) {
  return data && data.returnValue === "success" && Number.isFinite(Number(data.drwNo));
}

async function fetchDraw(drwNo) {
  const url = `${ENDPOINT}${drwNo}`;
  const res = await fetch(url, {
    headers: {
      "user-agent": "github-actions-lotto645-updater/1.1",
      accept: "application/json,text/plain,*/*",
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for drwNo=${drwNo}`);
  const data = await res.json();
  if (!isSuccess(data)) return null;

  const nums = [
    data.drwtNo1,
    data.drwtNo2,
    data.drwtNo3,
    data.drwtNo4,
    data.drwtNo5,
    data.drwtNo6,
  ]
    .map((x) => Number(x))
    .filter((x) => Number.isFinite(x));

  if (nums.length !== 6) return null;

  nums.sort((a, b) => a - b);

  return {
    drwNo: Number(data.drwNo),
    date: String(data.drwNoDate), // YYYY-MM-DD
    numbers: nums,
    bonus: Number(data.bnusNo),
  };
}

async function existsDraw(drwNo) {
  const d = await fetchDraw(drwNo);
  return d !== null;
}

async function findMaxDrawNo(lastKnown) {
  // Fast path: probe forward from lastKnown
  if (lastKnown && lastKnown > 0) {
    let n = lastKnown;
    for (let i = 0; i < 50; i++) {
      const next = n + 1;
      const ok = await existsDraw(next);
      if (!ok) return n;
      n = next;
      await sleep(120);
    }
    return n;
  }

  // Bootstrap: exponential search then binary search
  let low = 0;
  let high = 1;

  while (true) {
    const ok = await existsDraw(high);
    if (!ok) break;
    low = high;
    high *= 2;
    await sleep(120);
    if (high > 100000) throw new Error("Unreasonable high drwNo; abort.");
  }

  let lo = low + 1;
  let hi = high - 1;
  let best = low;

  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const ok = await existsDraw(mid);
    if (ok) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
    await sleep(120);
  }
  return best;
}

async function fetchRangeConcurrently(from, to, concurrency = 8) {
  const out = [];
  let cursor = from;
  let active = 0;

  return await new Promise((resolve, reject) => {
    const pump = async () => {
      while (active < concurrency && cursor <= to) {
        const n = cursor++;
        active++;
        (async () => {
          try {
            const d = await fetchDraw(n);
            if (d) out.push(d);
          } catch (e) {
            // retry once
            try {
              await sleep(220);
              const d2 = await fetchDraw(n);
              if (d2) out.push(d2);
            } catch (e2) {
              reject(new Error(`Failed fetching drwNo=${n}: ${e2?.message || e2}`));
              return;
            }
          } finally {
            active--;
            if (cursor > to && active === 0) resolve(out);
            else pump();
          }
        })();
      }
    };
    pump();
  });
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

  // 최근 N회차
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

async function main() {
  await fs.mkdir(DATA_DIR, { recursive: true });

  const existingDraws = await readJsonSafe(DRAWS_PATH, []);
  const byNo = new Map();
  for (const d of existingDraws) {
    if (d && Number.isFinite(d.drwNo)) byNo.set(Number(d.drwNo), d);
  }

  const lastKnown = existingDraws.length
    ? Math.max(...existingDraws.map((d) => Number(d.drwNo)).filter(Number.isFinite))
    : 0;

  console.log(`[lotto645] lastKnown=${lastKnown}`);

  // Re-fetch last 5 draws for safety
  const refetchFrom = Math.max(1, lastKnown - 5);

  const maxNo = await findMaxDrawNo(lastKnown);
  console.log(`[lotto645] maxNo=${maxNo}`);

  const fetched = await fetchRangeConcurrently(refetchFrom, maxNo, 8);
  for (const d of fetched) byNo.set(d.drwNo, d);

  const draws = [...byNo.values()].sort((a, b) => a.drwNo - b.drwNo);
  if (!draws.length) throw new Error("No draws fetched.");

  const last = draws[draws.length - 1];
  const freq = makeFreq(draws);

  const payloadFreq = {
    updatedAt: new Date().toISOString(),
    source: {
      endpoint: `${ENDPOINT}{drwNo}`,
      note: "Fetched by GitHub Actions, served as static JSON for Pages.",
    },
    lastDraw: {
      drwNo: last.drwNo,
      date: last.date,
      numbers: last.numbers,
      bonus: last.bonus,
    },
    totalDraws: draws.length,
    overall: freq.overall,
    recent: freq.recent, // keys: "10" | "20" | "30"
  };

  await writeJson(DRAWS_PATH, draws);
  await writeJson(FREQ_PATH, payloadFreq);

  console.log(`[lotto645] wrote draws=${draws.length}`);
  console.log(`[lotto645] lastDraw=${last.drwNo} (${last.date})`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
