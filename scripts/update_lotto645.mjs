// scripts/update_lotto645.mjs
// Node 20+
//
// Full features:
// - Multi-source fallback (Pages / raw.githubusercontent / jsDelivr)
// - 2-of-3 consensus validation for latest draw (and last few draws)
// - Incremental update as default (fast, less brittle)
// - Bootstrap via all.json when local is empty or gap is large
// - If everything fails: use local cache to keep Pages alive (exit 0), mark degraded
// - Generates freq for recent windows by last N draws: 10/20/30
// - Adds exponential decay weighted recent frequencies (more stable “recency”)
// - Writes schemaVersion + health status for UI + alert workflow

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const DRAWS_PATH = path.join(DATA_DIR, "lotto645_draws.json");
const FREQ_PATH = path.join(DATA_DIR, "lotto645_freq.json");

const SCHEMA_VERSION = 3;

// Fallback sources (same dataset, different infra)
const SOURCES = [
  {
    id: "smok95-pages",
    all: "https://smok95.github.io/lotto/results/all.json",
    latest: "https://smok95.github.io/lotto/results/latest.json",
    draw: (n) => `https://smok95.github.io/lotto/results/${n}.json`,
  },
  {
    id: "smok95-raw",
    all: "https://raw.githubusercontent.com/smok95/lotto/main/results/all.json",
    latest: "https://raw.githubusercontent.com/smok95/lotto/main/results/latest.json",
    draw: (n) => `https://raw.githubusercontent.com/smok95/lotto/main/results/${n}.json`,
  },
  {
    id: "smok95-jsdelivr",
    all: "https://cdn.jsdelivr.net/gh/smok95/lotto@main/results/all.json",
    latest: "https://cdn.jsdelivr.net/gh/smok95/lotto@main/results/latest.json",
    draw: (n) => `https://cdn.jsdelivr.net/gh/smok95/lotto@main/results/${n}.json`,
  },
];

const BOOTSTRAP_GAP_THRESHOLD = 120; // local 비어있거나 gap이 크면 all.json으로 부트스트랩
const VALIDATE_LAST_K = 5;          // 마지막 K회차 교차검증/패치
const RECENT_WINDOWS = [10, 20, 30];
const DECAY = 0.95;                 // 지수감쇠 (최근 회차일수록 가중↑)

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
        "user-agent": "github-actions-lotto645-updater/4.0",
        accept: "application/json,text/plain,*/*",
      },
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}\n${text.slice(0, 220)}`);
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
      const text = await fetchTextWithTimeout(url, 25000 + i * 6000);
      if (isHtmlLike(text)) {
        throw new Error(`Expected JSON but got HTML from ${url}\n${text.trimStart().slice(0, 200)}`);
      }
      return JSON.parse(text);
    } catch (e) {
      lastErr = e;
      if (i < retries) await sleep(500 + i * 700);
    }
  }
  throw lastErr;
}

function toYmd(isoOrYmd) {
  if (!isoOrYmd) return null;
  const s = String(isoOrYmd);
  return s.length >= 10 ? s.slice(0, 10) : s;
}

function normalizeDraw(item) {
  // smok95 latest/draw format:
  // { draw_no, numbers:[..], bonus_no, date:"YYYY-MM-DDT00:00:00Z", ... }
  const drwNo = Number(item?.draw_no);
  const nums = Array.isArray(item?.numbers) ? item.numbers.map(Number) : [];
  const bonus = Number(item?.bonus_no);
  const date = toYmd(item?.date);

  if (!Number.isFinite(drwNo) || nums.length !== 6 || !date) return null;
  const sorted = nums.slice().sort((a, b) => a - b);
  return { drwNo, date, numbers: sorted, bonus };
}

function drawSig(d) {
  // signature for consensus: drwNo + numbers + bonus + date
  return `${d.drwNo}|${d.numbers.join(",")}|b${d.bonus}|${d.date}`;
}

function initCounterInt() {
  const c = {};
  for (let i = 1; i <= 45; i++) c[i] = 0;
  return c;
}

function initCounterFloat() {
  const c = {};
  for (let i = 1; i <= 45; i++) c[i] = 0.0;
  return c;
}

function addCount(counter, n, w = 1) {
  if (n >= 1 && n <= 45) counter[n] += w;
}

function makeFreq(draws) {
  const overallMain = initCounterInt();
  const overallBonus = initCounterInt();

  for (const d of draws) {
    for (const n of d.numbers) addCount(overallMain, n, 1);
    addCount(overallBonus, d.bonus, 1);
  }

  const recent = {};
  const recentWeighted = {};

  for (const win of RECENT_WINDOWS) {
    const slice = draws.slice(-win);

    // raw counts
    const main = initCounterInt();
    const bonus = initCounterInt();

    // decay-weighted
    const wmain = initCounterFloat();
    const wbonus = initCounterFloat();

    // newest first for decay (k=0 newest)
    const newestFirst = slice.slice().reverse();

    for (let k = 0; k < newestFirst.length; k++) {
      const d = newestFirst[k];
      const w = Math.pow(DECAY, k);
      for (const x of d.numbers) addCount(wmain, x, w);
      addCount(wbonus, d.bonus, w);
    }

    for (const d of slice) {
      for (const x of d.numbers) addCount(main, x, 1);
      addCount(bonus, d.bonus, 1);
    }

    const from = slice.length ? slice[0].date : null;
    const to = slice.length ? slice[slice.length - 1].date : null;

    recent[String(win)] = { from, to, drawCount: slice.length, main, bonus };
    recentWeighted[String(win)] = {
      from,
      to,
      drawCount: slice.length,
      decay: DECAY,
      main: wmain,
      bonus: wbonus,
    };
  }

  return { overall: { main: overallMain, bonus: overallBonus }, recent, recentWeighted };
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

async function tryLatestFromSource(src) {
  const obj = await fetchJsonGuarded(src.latest, 2);
  const d = normalizeDraw(obj);
  if (!d) throw new Error(`[${src.id}] latest invalid`);
  return { sourceId: src.id, url: src.latest, draw: d };
}

async function tryAllFromSource(src) {
  const arr = await fetchJsonGuarded(src.all, 2);
  if (!Array.isArray(arr) || arr.length === 0) throw new Error(`[${src.id}] all.json empty/non-array`);
  const mapped = [];
  for (const it of arr) {
    const d = normalizeDraw(it);
    if (d) mapped.push(d);
  }
  if (!mapped.length) throw new Error(`[${src.id}] all.json parsed 0 draws`);
  mapped.sort((a, b) => a.drwNo - b.drwNo);
  return { sourceId: src.id, url: src.all, draws: mapped };
}

async function tryDrawFromSource(src, n) {
  const obj = await fetchJsonGuarded(src.draw(n), 2);
  const d = normalizeDraw(obj);
  if (!d) throw new Error(`[${src.id}] draw ${n} invalid`);
  return { sourceId: src.id, url: src.draw(n), draw: d };
}

function pickConsensusLatest(latestResults) {
  // latestResults: [{sourceId, draw}]
  // 1) group by drwNo
  const byNo = new Map();
  for (const r of latestResults) {
    const n = r.draw.drwNo;
    if (!byNo.has(n)) byNo.set(n, []);
    byNo.get(n).push(r);
  }

  // choose max drawNo that has >=2 sources; else choose max drawNo any
  const nos = [...byNo.keys()].sort((a, b) => b - a);
  let targetNo = null;
  for (const n of nos) {
    if (byNo.get(n).length >= 2) {
      targetNo = n;
      break;
    }
  }
  if (targetNo === null) targetNo = nos[0];

  const candidates = byNo.get(targetNo) || [];

  // 2) within targetNo, group by signature
  const bySig = new Map();
  for (const r of candidates) {
    const sig = drawSig(r.draw);
    if (!bySig.has(sig)) bySig.set(sig, []);
    bySig.get(sig).push(r);
  }

  // pick sig with max count; tie -> prefer first
  const sigs = [...bySig.entries()].sort((a, b) => b[1].length - a[1].length);
  const [bestSig, bestArr] = sigs[0];

  const consensusCount = bestArr.length;
  const agreed = consensusCount >= 2;

  return {
    latestNo: targetNo,
    consensusDraw: bestArr[0].draw,
    agreed,
    consensusCount,
    detail: {
      byNo: [...byNo.entries()].map(([n, arr]) => ({ drwNo: n, sources: arr.map((x) => x.sourceId) })),
      bySig: [...bySig.entries()].map(([sig, arr]) => ({ sig, sources: arr.map((x) => x.sourceId) })),
    },
  };
}

async function fetchLatestAllSources() {
  const out = [];
  const errs = [];
  await Promise.allSettled(
    SOURCES.map(async (src) => {
      try {
        const r = await tryLatestFromSource(src);
        out.push(r);
      } catch (e) {
        errs.push({ sourceId: src.id, error: String(e?.message || e) });
      }
    })
  );
  return { results: out, errors: errs };
}

async function fetchDrawWithFallback(n) {
  let lastErr = null;
  for (const src of SOURCES) {
    try {
      const r = await tryDrawFromSource(src, n);
      return r;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error(`draw ${n} fetch failed`);
}

async function fetchAllWithFallback() {
  let lastErr = null;
  for (const src of SOURCES) {
    try {
      const r = await tryAllFromSource(src);
      return r;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("all.json fetch failed");
}

async function main() {
  await fs.mkdir(DATA_DIR, { recursive: true });

  const existing = await readJsonSafe(DRAWS_PATH, []);
  const existingLastNo =
    existing.length > 0 ? Math.max(...existing.map((d) => Number(d?.drwNo)).filter(Number.isFinite)) : 0;

  console.log(`[lotto645] existing draws=${existing.length}, lastNo=${existingLastNo}`);

  const health = {
    status: "ok", // ok | degraded
    reasons: [],
    used: { mode: null, sourceId: null, note: null },
    latestConsensus: null,
    latestFetchErrors: [],
    validatedTail: { attempted: 0, patched: 0, mismatched: 0 },
  };

  // ---- 1) latest (2-of-3 consensus) ----
  const latestPack = await fetchLatestAllSources();
  health.latestFetchErrors = latestPack.errors;

  if (latestPack.results.length === 0) {
    // cannot get latest from anywhere
    if (existing.length > 0) {
      health.status = "degraded";
      health.reasons.push("latest_unavailable_all_sources_using_local_cache");
      health.used = { mode: "local-only", sourceId: "local-cache", note: "No latest reachable" };
      // regenerate freq from local
      const draws = existing.slice().sort((a, b) => a.drwNo - b.drwNo);
      const last = draws[draws.length - 1];
      const freq = makeFreq(draws);

      const payload = {
        schemaVersion: SCHEMA_VERSION,
        updatedAt: new Date().toISOString(),
        health,
        source: {
          endpoints: SOURCES.map((s) => ({ id: s.id, latest: s.latest, all: s.all })),
        },
        lastDraw: { drwNo: last.drwNo, date: last.date, numbers: last.numbers, bonus: last.bonus },
        totalDraws: draws.length,
        overall: freq.overall,
        recent: freq.recent,
        recentWeighted: freq.recentWeighted,
      };

      await writeJson(DRAWS_PATH, draws);
      await writeJson(FREQ_PATH, payload);

      console.log(`[lotto645] wrote (local-only) draws=${draws.length}, last=${last.drwNo}`);
      return;
    }
    throw new Error("No sources reachable for latest, and no local cache.");
  }

  const consensus = pickConsensusLatest(latestPack.results);
  health.latestConsensus = consensus;

  if (!consensus.agreed) {
    health.status = "degraded";
    health.reasons.push("latest_consensus_not_2of3");
  }

  const latestNo = consensus.latestNo;
  const consensusDraw = consensus.consensusDraw;

  // ---- 2) choose strategy: bootstrap(all) vs incremental ----
  const gap = latestNo - existingLastNo;
  const needBootstrap = existingLastNo === 0 || gap > BOOTSTRAP_GAP_THRESHOLD;

  let draws = null;

  if (needBootstrap) {
    // Bootstrap via all.json (fast start)
    try {
      const all = await fetchAllWithFallback();
      draws = all.draws;
      health.used = { mode: "bootstrap-all", sourceId: all.sourceId, note: `gap=${gap}` };

      const last = draws[draws.length - 1];
      if (last.drwNo !== latestNo) {
        health.status = "degraded";
        health.reasons.push("all_json_last_draw_no_mismatch_with_latest");
      } else {
        // if same drawNo, check signature vs consensus (2-of-3)
        if (drawSig(last) !== drawSig(consensusDraw)) {
          health.status = "degraded";
          health.reasons.push("all_json_last_signature_mismatch_with_consensus");
          // patch last draw using consensus (and/or per-draw fetch)
          draws = mergeByNo(draws, [consensusDraw]);
        }
      }
    } catch (e) {
      health.status = "degraded";
      health.reasons.push("bootstrap_all_failed_try_incremental");
      // fallback to incremental if local exists, otherwise incremental from 1..latest (too slow)
      if (existingLastNo > 0) {
        draws = existing.slice();
        health.used = { mode: "incremental-from-local", sourceId: "local-cache", note: "bootstrap failed" };
      } else {
        // last resort: incremental from scratch (may take long), but try anyway
        draws = [];
        health.used = { mode: "incremental-from-scratch", sourceId: "multi", note: "bootstrap failed" };
      }
    }
  } else {
    draws = existing.slice().sort((a, b) => a.drwNo - b.drwNo);
    health.used = { mode: "incremental", sourceId: "multi", note: `gap=${gap}` };
  }

  // ---- 3) incremental fill to latestNo ----
  const currentLastNo = draws.length
    ? Math.max(...draws.map((d) => Number(d?.drwNo)).filter(Number.isFinite))
    : 0;

  if (currentLastNo < latestNo) {
    for (let n = currentLastNo + 1; n <= latestNo; n++) {
      try {
        const got = await fetchDrawWithFallback(n);
        draws = mergeByNo(draws, [got.draw]);
        console.log(`[lotto645] fetched draw ${n} via ${got.sourceId}`);
        // light throttle
        if (n % 8 === 0) await sleep(120);
      } catch (e) {
        // Do not hard-fail if we have some local data; keep Pages alive
        health.status = "degraded";
        health.reasons.push(`incremental_fetch_failed_at_${n}`);
        health.used.note = `stopped_at=${n}`;
        break;
      }
    }
  }

  // ensure consensus latest patched
  draws = mergeByNo(draws, [consensusDraw]);

  // ---- 4) validate last K (2-of-3 check using per-draw) ----
  // We validate only if we can (latest results existed); patch mismatches
  const lastNoAfter = draws.length
    ? Math.max(...draws.map((d) => Number(d?.drwNo)).filter(Number.isFinite))
    : 0;

  const startValidate = Math.max(1, lastNoAfter - VALIDATE_LAST_K + 1);
  for (let n = startValidate; n <= lastNoAfter; n++) {
    health.validatedTail.attempted++;

    // fetch from each source (best effort), then majority signature
    const fetched = [];
    await Promise.allSettled(
      SOURCES.map(async (src) => {
        try {
          const r = await tryDrawFromSource(src, n);
          fetched.push(r);
        } catch {
          // ignore per source
        }
      })
    );

    if (fetched.length < 2) continue;

    const bySig = new Map();
    for (const r of fetched) {
      const sig = drawSig(r.draw);
      if (!bySig.has(sig)) bySig.set(sig, []);
      bySig.get(sig).push(r);
    }
    const ranked = [...bySig.entries()].sort((a, b) => b[1].length - a[1].length);
    const best = ranked[0];
    const bestSig = best[0];
    const bestCount = best[1].length;

    if (bestCount < 2) {
      health.status = "degraded";
      health.reasons.push(`tail_${n}_no_2of3_consensus`);
      continue;
    }

    const bestDraw = best[1][0].draw;

    // compare local
    const local = draws.find((d) => d.drwNo === n);
    if (!local || drawSig(local) !== bestSig) {
      health.validatedTail.mismatched++;
      draws = mergeByNo(draws, [bestDraw]);
      health.validatedTail.patched++;
      health.status = "degraded";
      health.reasons.push(`tail_${n}_patched_from_consensus`);
    }
  }

  // ---- 5) finalize ----
  draws.sort((a, b) => a.drwNo - b.drwNo);
  if (!draws.length) throw new Error("No draws available after update.");

  const last = draws[draws.length - 1];
  const freq = makeFreq(draws);

  // if latestNo exists but local last is behind, mark degraded
  if (last.drwNo < latestNo) {
    health.status = "degraded";
    health.reasons.push("local_last_is_behind_latest");
  }

  const payload = {
    schemaVersion: SCHEMA_VERSION,
    updatedAt: new Date().toISOString(),
    health,
    source: {
      endpoints: SOURCES.map((s) => ({ id: s.id, latest: s.latest, all: s.all })),
      note: "2-of-3 consensus + incremental default + fallback + local-cache survival",
    },
    lastDraw: { drwNo: last.drwNo, date: last.date, numbers: last.numbers, bonus: last.bonus },
    totalDraws: draws.length,
    overall: freq.overall,
    recent: freq.recent,
    recentWeighted: freq.recentWeighted,
  };

  await writeJson(DRAWS_PATH, draws);
  await writeJson(FREQ_PATH, payload);

  console.log(`[lotto645] wrote draws=${draws.length}`);
  console.log(`[lotto645] lastDraw=${last.drwNo} (${last.date})`);
  console.log(`[lotto645] health=${health.status} reasons=${health.reasons.length}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
