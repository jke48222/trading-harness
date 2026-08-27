import type { Candle, ReplaySetup } from './types';
import { CONFIG } from './config';
import { closedCandles, fetchSeries, fetchSeriesSince, intervalToMs } from './market';
import { signalAt } from './strategy';
import { regimeAllows, regimeAt } from './regime';
import {
  appendLedgerRow,
  ensureMemoryFiles,
  learningsPath,
  ledgerPath,
  lessonsFor,
  loadLedger,
  memoryIsEmpty,
  upsertLesson,
} from './memory';
import { consultMemory } from './adaptiveFilter';
import { appendTrialRow, trialCount, trialsPath } from './trials';

function iso(t: number): string {
  return new Date(t).toISOString();
}

function short(t: number): string {
  return new Date(t).toISOString().slice(0, 16) + 'Z';
}

function fmtPnl(p: number | null): string {
  if (p === null) return '—';
  return (p >= 0 ? '+' : '') + p.toFixed(3);
}

async function loadReplayCandles(): Promise<Candle[]> {
  const { symbol, interval, replayCandles } = CONFIG;
  console.log(`Fetching ${replayCandles} real ${interval} candles for ${symbol}…`);
  const raw =
    replayCandles > 1000
      ? await fetchSeriesSince(symbol, interval, Date.now() - replayCandles * intervalToMs(interval))
      : await fetchSeries(symbol, interval, replayCandles);
  const candles = closedCandles(raw);
  console.log(
    `Loaded ${candles.length} closed candles: ${short(candles[0].closeTime)} -> ${short(candles[candles.length - 1].closeTime)}`
  );
  console.log(
    `Scoring model: enter at signal-candle close, exit at close ${CONFIG.evalHorizon} candles later, ` +
      `${CONFIG.feeBps} bps round-trip fee+slippage. Each setup is scored independently (setup-quality study, not a compounding portfolio).`
  );
  return candles;
}

/** Closed HTF candles covering the replay window plus MA warmup — only fetched when the regime filter is on. */
async function loadHtfCandles(windowStartMs: number): Promise<Candle[] | null> {
  if (!CONFIG.regimeFilter) return null;
  const { symbol, htfInterval, htfMa } = CONFIG;
  const start = windowStartMs - (htfMa + 5) * intervalToMs(htfInterval);
  const htf = closedCandles(await fetchSeriesSince(symbol, htfInterval, start));
  console.log(
    `Regime filter ON (Trial 02): ${htfInterval} SMA${htfMa}, ${htf.length} closed ${htfInterval} candles loaded — ` +
      'BUY only in uptrend, SELL only in downtrend, computed on closed HTF candles only.'
  );
  return htf;
}

/** Every crossover setup in the window, scored forward. Real candles in, real outcomes out. Exported for analysis scripts (Trial 06). */
export function computeSetups(candles: Candle[], htf: Candle[] | null = null): { setups: ReplaySetup[]; filteredOut: number } {
  const { evalHorizon, feeBps, slowPeriod } = CONFIG;
  const warmup =
    CONFIG.strategyName === 'donchian-breakout'
      ? Math.max(CONFIG.donchianLen + 1, CONFIG.trendAlign ? CONFIG.trendMa : 0)
      : CONFIG.strategyName === 'tsmom'
        ? CONFIG.tsmomLookback + 1
        : slowPeriod;
  // Optional IS/OOS window: a setup counts only if it enters AND exits inside
  // the window (boundary-crossers are excluded as incomplete — no leakage).
  const winStart = CONFIG.replayWindowStart ? Date.parse(CONFIG.replayWindowStart) : -Infinity;
  const winEnd = CONFIG.replayWindowEnd ? Date.parse(CONFIG.replayWindowEnd) : Infinity;
  const setups: ReplaySetup[] = [];
  let filteredOut = 0;
  for (let i = warmup; i < candles.length; i++) {
    if (candles[i].closeTime < winStart || candles[i].closeTime > winEnd) continue;
    const sig = signalAt(candles, i);
    if (sig.action === 'HOLD') continue;
    if (htf) {
      const verdict = regimeAt(htf, candles[i].closeTime);
      if (!regimeAllows(sig.action, verdict.regime)) {
        filteredOut++;
        continue;
      }
    }
    const entryPrice = candles[i].close;
    const exitIdx = i + evalHorizon;
    if (exitIdx >= candles.length || candles[exitIdx].closeTime > winEnd) {
      setups.push({
        index: i,
        time: candles[i].closeTime,
        action: sig.action,
        setupTag: sig.setupTag,
        entryPrice,
        exitPrice: null,
        pnlPct: null,
        outcome: 'incomplete',
        reason: sig.reason,
      });
      continue;
    }
    const exitPrice = candles[exitIdx].close;
    const grossPct =
      sig.action === 'BUY'
        ? ((exitPrice - entryPrice) / entryPrice) * 100
        : ((entryPrice - exitPrice) / entryPrice) * 100;
    const pnlPct = grossPct - feeBps / 100;
    setups.push({
      index: i,
      time: candles[i].closeTime,
      action: sig.action,
      setupTag: sig.setupTag,
      entryPrice,
      exitPrice,
      pnlPct,
      outcome: pnlPct > 0 ? 'win' : pnlPct < 0 ? 'loss' : 'flat',
      reason: sig.reason,
    });
  }
  return { setups, filteredOut };
}

interface Stats {
  completed: number;
  incomplete: number;
  wins: number;
  losses: number;
  winRate: number;
  totalPnl: number;
  avgPnl: number;
  best: ReplaySetup | null;
  worst: ReplaySetup | null;
  maxDrawdown: number;
}

function computeStats(setups: ReplaySetup[]): Stats {
  const completed = setups.filter((s) => s.outcome !== 'incomplete');
  const wins = completed.filter((s) => s.outcome === 'win').length;
  const losses = completed.filter((s) => s.outcome === 'loss').length;
  const totalPnl = completed.reduce((a, s) => a + (s.pnlPct ?? 0), 0);
  let best: ReplaySetup | null = null;
  let worst: ReplaySetup | null = null;
  for (const s of completed) {
    if (best === null || (s.pnlPct ?? 0) > (best.pnlPct ?? 0)) best = s;
    if (worst === null || (s.pnlPct ?? 0) < (worst.pnlPct ?? 0)) worst = s;
  }
  let cum = 0;
  let peak = 0;
  let maxDrawdown = 0;
  for (const s of completed) {
    cum += s.pnlPct ?? 0;
    if (cum > peak) peak = cum;
    if (peak - cum > maxDrawdown) maxDrawdown = peak - cum;
  }
  return {
    completed: completed.length,
    incomplete: setups.length - completed.length,
    wins,
    losses,
    winRate: completed.length ? (wins / completed.length) * 100 : 0,
    totalPnl,
    avgPnl: completed.length ? totalPnl / completed.length : 0,
    best,
    worst,
    maxDrawdown,
  };
}

function printTable(setups: ReplaySetup[], title: string): void {
  console.log(`\n${title}`);
  const header =
    '  #'.padEnd(5) +
    'time'.padEnd(19) +
    'action'.padEnd(8) +
    'setup'.padEnd(26) +
    'entry'.padStart(12) +
    'exit'.padStart(12) +
    'pnl%'.padStart(9) +
    '  outcome';
  console.log(header);
  console.log('-'.repeat(header.length));
  setups.forEach((s, i) => {
    console.log(
      String(i + 1).padStart(3).padEnd(5) +
        short(s.time).padEnd(19) +
        s.action.padEnd(8) +
        s.setupTag.padEnd(26) +
        s.entryPrice.toFixed(2).padStart(12) +
        (s.exitPrice === null ? '—' : s.exitPrice.toFixed(2)).padStart(12) +
        fmtPnl(s.pnlPct).padStart(9) +
        '  ' +
        s.outcome
    );
  });
}

function printStats(s: Stats, label: string): void {
  console.log(`\n${label} (net of ${CONFIG.feeBps} bps costs):`);
  console.log(`  Setups completed: ${s.completed}${s.incomplete ? ` (+${s.incomplete} incomplete — not enough forward candles, excluded from stats)` : ''}`);
  console.log(`  Wins: ${s.wins} · Losses: ${s.losses} · Win rate: ${s.winRate.toFixed(1)}%`);
  console.log(`  Total PnL: ${fmtPnl(s.totalPnl)}% · Avg per setup: ${fmtPnl(s.avgPnl)}%`);
  if (s.best && s.worst) {
    console.log(`  Best: ${fmtPnl(s.best.pnlPct)}% (${s.best.setupTag} @ ${short(s.best.time)}) · Worst: ${fmtPnl(s.worst.pnlPct)}% (${s.worst.setupTag} @ ${short(s.worst.time)})`);
  }
  console.log(`  Max drawdown of cumulative PnL: ${s.maxDrawdown.toFixed(3)}%`);
}

/** Gross wins over gross losses, the classic assessability metric. Null when there are no losses to divide by. */
function profitFactor(setups: ReplaySetup[]): number | null {
  let grossWin = 0;
  let grossLoss = 0;
  for (const s of setups) {
    if (s.outcome === 'incomplete' || s.pnlPct === null) continue;
    if (s.pnlPct > 0) grossWin += s.pnlPct;
    if (s.pnlPct < 0) grossLoss += -s.pnlPct;
  }
  return grossLoss === 0 ? null : grossWin / grossLoss;
}

/** Every replay evaluation is a "trial" — disclosed in data/trials.csv so results stay assessable (research finding F6). */
function logTrial(command: string, memoryFilter: boolean, candles: Candle[], setups: ReplaySetup[], stats: Stats, notes: string): void {
  appendTrialRow({
    runAt: new Date().toISOString(),
    source: 'local-replay',
    command,
    symbol: CONFIG.symbol,
    interval: CONFIG.interval,
    strategy: CONFIG.strategyName,
    params: JSON.stringify(
      CONFIG.strategyName === 'donchian-breakout'
        ? {
            len: CONFIG.donchianLen,
            horizon: CONFIG.evalHorizon,
            trendAlign: CONFIG.trendAlign ? `sma${CONFIG.trendMa}` : 'off',
            longOnly: CONFIG.longOnly,
            memoryFilter,
          }
        : CONFIG.strategyName === 'tsmom'
        ? {
            lookback: CONFIG.tsmomLookback,
            horizon: CONFIG.evalHorizon,
            longOnly: CONFIG.longOnly,
            memoryFilter,
          }
        : {
            fast: CONFIG.fastPeriod,
            slow: CONFIG.slowPeriod,
            horizon: CONFIG.evalHorizon,
            memoryFilter,
            memoryMinLosses: CONFIG.memoryMinLosses,
            regime: CONFIG.regimeFilter ? `${CONFIG.htfInterval}-sma${CONFIG.htfMa}` : 'off',
          }
    ),
    windowStart: CONFIG.replayWindowStart || iso(candles[0].closeTime),
    windowEnd: CONFIG.replayWindowEnd || iso(candles[candles.length - 1].closeTime),
    setups: stats.completed,
    wins: stats.wins,
    losses: stats.losses,
    winRatePct: stats.winRate,
    profitFactor: profitFactor(setups),
    totalPnlPct: stats.totalPnl,
    avgPnlPct: stats.avgPnl,
    maxDdPct: stats.maxDrawdown,
    feeBps: CONFIG.feeBps,
    notes,
  });
}

interface TagGroup {
  completed: number;
  wins: number;
  losses: number;
  net: number;
  lastLossTime: number;
}

function groupByTag(setups: ReplaySetup[]): Map<string, TagGroup> {
  const groups = new Map<string, TagGroup>();
  for (const s of setups) {
    if (s.outcome === 'incomplete') continue;
    const g = groups.get(s.setupTag) ?? { completed: 0, wins: 0, losses: 0, net: 0, lastLossTime: 0 };
    g.completed++;
    g.net += s.pnlPct ?? 0;
    if (s.outcome === 'win') g.wins++;
    if (s.outcome === 'loss') {
      g.losses++;
      if (s.time > g.lastLossTime) g.lastLossTime = s.time;
    }
    groups.set(s.setupTag, g);
  }
  return groups;
}

function ledgerKeys(): Set<string> {
  return new Set(loadLedger().map((r) => `${r.timestamp}|${r.symbol}|${r.mode}|${r.action}`));
}

/** Honest baseline: every setup, memory ignored. Real outcomes are then written into memory. */
export async function runReplayRaw(): Promise<void> {
  const candles = await loadReplayCandles();
  const htf = await loadHtfCandles(candles[0].closeTime);
  const { setups, filteredOut } = computeSetups(candles, htf);
  if (htf) console.log(`Regime filter: ${filteredOut} counter-regime setups filtered out before scoring.`);

  if (setups.length === 0) {
    console.log(
      '\nNo crossover setups appeared in this window of real data — that is the honest result. ' +
        'Try a larger REPLAY_CANDLES, another INTERVAL, or another SYMBOL.'
    );
    if (setups.length + filteredOut > 0) {
      logTrial('replay:raw', false, candles, setups, computeStats(setups), `all ${filteredOut} setups filtered by regime`);
      console.log(`Trials: disclosed in ${trialsPath()} — ${trialCount()} configuration test(s) recorded to date.`);
    }
    return;
  }

  printTable(setups, `Raw replay — every ${CONFIG.fastPeriod}/${CONFIG.slowPeriod} crossover setup in the window (memory ignored):`);
  const stats = computeStats(setups);
  printStats(stats, 'Raw baseline');

  if (stats.completed < 5) {
    console.log(`\nNote: only ${stats.completed} completed setups — too few to draw reliable conclusions yet.`);
  }

  const groups = groupByTag(setups);
  const weak = [...groups.entries()].filter(([, g]) => g.losses >= CONFIG.memoryMinLosses && g.net < 0);
  if (weak.length > 0) {
    console.log('\nRepeated weak setups actually present in this data:');
    for (const [tag, g] of weak) {
      console.log(`  ${tag}: ${g.losses} losses of ${g.completed} (net ${fmtPnl(g.net)}%)`);
    }
  } else {
    console.log('\nNo repeated losing pattern in this window — that is a real result, nothing was forced to fail.');
  }

  if (CONFIG.replayWriteMemory) {
    // Write REAL outcomes into memory (deduplicated on re-runs).
    ensureMemoryFiles();
    const existing = ledgerKeys();
    let appended = 0;
    for (const s of setups) {
      if (s.outcome === 'incomplete') continue;
      const timestamp = iso(s.time);
      const key = `${timestamp}|${CONFIG.symbol}|replay-raw|${s.action}`;
      if (existing.has(key)) continue;
      appendLedgerRow({
        timestamp,
        symbol: CONFIG.symbol,
        action: s.action,
        price: s.entryPrice.toFixed(2),
        quantity: String(CONFIG.quantity),
        reason: `[${s.setupTag}] ${s.reason}`,
        mode: 'replay-raw',
        outcome: s.outcome,
        pnl: (s.pnlPct ?? 0).toFixed(4),
      });
      appended++;
    }
    console.log(`\nLedger: appended ${appended} new real replay outcomes to ${ledgerPath()} (re-runs are deduplicated).`);

    let lessons = 0;
    for (const [tag, g] of groups) {
      if (g.losses === 0) continue; // No real loss -> no lesson. Nothing is seeded.
      upsertLesson(
        tag,
        `Lost ${g.losses} of ${g.completed} replay setups on ${CONFIG.symbol} ${CONFIG.interval} ` +
          `(net ${g.net.toFixed(2)}% after ${CONFIG.feeBps} bps costs), last loss ${short(g.lastLossTime)}. ` +
          `Skip fresh ${tag} signals while prior losses >= ${CONFIG.memoryMinLosses} and net PnL is negative.`
      );
      lessons++;
    }
    console.log(
      lessons > 0
        ? `Learnings: ${lessons} lesson(s) written/updated in ${learningsPath()} — from real losing setups only.`
        : `Learnings: no losing setups, so no lesson was written (nothing is invented).`
    );
  } else {
    console.log(
      '\nResearch run: ledger.csv and learnings.md NOT written (REPLAY_WRITE_MEMORY=false) — ' +
        'forward trade memory stays clean; the trial is still disclosed below.'
    );
  }

  const regimeNote = CONFIG.regimeFilter ? `; ${filteredOut} setups filtered by regime` : '';
  logTrial(
    'replay:raw',
    false,
    candles,
    setups,
    stats,
    `${stats.incomplete} incomplete setups excluded; per-setup study, non-compounding${regimeNote}`
  );
  console.log(`Trials: this run is disclosed in ${trialsPath()} — ${trialCount()} configuration test(s) recorded to date.`);
}

/** Same window, but memory is consulted before every setup — then raw vs memory compared honestly. */
export async function runReplayMemory(): Promise<void> {
  if (memoryIsEmpty()) {
    console.log('Memory is empty — data/ledger.csv has no real prior outcomes.');
    console.log(
      'This bot never invents a reason to skip, so there is nothing for memory mode to do yet. ' +
        'Run `npm run replay:raw` first to seed memory from real historical outcomes, then run this again.'
    );
    return;
  }

  const candles = await loadReplayCandles();
  const htf = await loadHtfCandles(candles[0].closeTime);
  const { setups: all, filteredOut } = computeSetups(candles, htf);
  if (htf) console.log(`Regime filter: ${filteredOut} counter-regime setups filtered out before memory is even consulted.`);
  if (all.length === 0) {
    console.log('\nNo crossover setups appeared in this window of real data — nothing to compare.');
    return;
  }

  const taken: ReplaySetup[] = [];
  const skipped: { setup: ReplaySetup; reason: string }[] = [];
  for (const s of all) {
    const verdict = consultMemory(CONFIG.symbol, s.setupTag, s.time);
    if (verdict.blocked) skipped.push({ setup: s, reason: verdict.reason });
    else taken.push(s);
  }

  printTable(taken, 'Memory-enabled replay — setups the bot still takes:');
  if (skipped.length > 0) {
    console.log('\nSetups SKIPPED by memory (each backed by real prior losses in the ledger):');
    for (const { setup, reason } of skipped) {
      console.log(`  ${short(setup.time)} ${setup.action} ${setup.setupTag} @ ${setup.entryPrice.toFixed(2)}`);
      console.log(`    -> ${reason}`);
    }
  } else {
    console.log(
      '\nMemory blocked nothing in this window — no setup matched a real prior losing pattern ' +
        `(threshold: >= ${CONFIG.memoryMinLosses} losses, net negative, learnings warning). Keep paper testing to accumulate more real memory.`
    );
  }

  const rawStats = computeStats(all);
  const memStats = computeStats(taken);
  printStats(rawStats, 'RAW baseline (all setups, memory ignored)');
  printStats(memStats, 'MEMORY-enabled (after skips)');

  const skippedCompleted = skipped.filter((x) => x.setup.outcome !== 'incomplete');
  const skippedPnl = skippedCompleted.reduce((a, x) => a + (x.setup.pnlPct ?? 0), 0);
  console.log('\nRaw vs memory — same window, same rules, the only difference is memory:');
  console.log(`  Setups taken: ${rawStats.completed} raw vs ${memStats.completed} memory (${skippedCompleted.length} skipped)`);
  console.log(`  Total PnL: ${fmtPnl(rawStats.totalPnl)}% raw vs ${fmtPnl(memStats.totalPnl)}% memory`);
  if (skippedCompleted.length > 0) {
    console.log(
      `  Combined PnL of skipped setups had they been taken: ${fmtPnl(skippedPnl)}% — memory ` +
        (skippedPnl < 0
          ? 'avoided a net loss in this window.'
          : skippedPnl > 0
            ? 'also skipped net winners here — its record HURT in this window. That is reported honestly, not hidden.'
            : 'made no net difference in this window.')
    );
  }

  if (!CONFIG.replayWriteMemory) {
    console.log(
      '\nResearch run: ledger.csv NOT written (REPLAY_WRITE_MEMORY=false) — trials are still disclosed below.'
    );
    logTrial('replay:memory (raw baseline)', false, candles, all, rawStats, 'baseline computed inside replay:memory for comparison');
    logTrial('replay:memory', true, candles, taken, memStats, `${skippedCompleted.length} completed setups skipped by memory`);
    console.log(`Trials: both looks disclosed in ${trialsPath()} — ${trialCount()} configuration test(s) recorded to date.`);
    return;
  }

  // Log memory decisions to the ledger (deduplicated).
  const existing = ledgerKeys();
  let appended = 0;
  for (const { setup, reason } of skipped) {
    const timestamp = iso(setup.time);
    const key = `${timestamp}|${CONFIG.symbol}|replay-memory|SKIP`;
    if (existing.has(key)) continue;
    appendLedgerRow({
      timestamp,
      symbol: CONFIG.symbol,
      action: 'SKIP',
      price: setup.entryPrice.toFixed(2),
      quantity: '0',
      reason: `[${setup.setupTag}] ${reason}`,
      mode: 'replay-memory',
      outcome: 'skipped',
      pnl: '',
    });
    existing.add(key);
    appended++;
  }
  for (const s of taken) {
    if (s.outcome === 'incomplete') continue;
    const timestamp = iso(s.time);
    const key = `${timestamp}|${CONFIG.symbol}|replay-memory|${s.action}`;
    if (existing.has(key)) continue;
    appendLedgerRow({
      timestamp,
      symbol: CONFIG.symbol,
      action: s.action,
      price: s.entryPrice.toFixed(2),
      quantity: String(CONFIG.quantity),
      reason: `[${s.setupTag}] ${s.reason}`,
      mode: 'replay-memory',
      outcome: s.outcome,
      pnl: (s.pnlPct ?? 0).toFixed(4),
    });
    existing.add(key);
    appended++;
  }
  console.log(`\nLedger: ${appended} memory-mode decision rows appended to ${ledgerPath()}.`);

  const rows = loadLedger();
  if (rows.length > 0) {
    const last = rows[rows.length - 1];
    console.log(`Latest ledger row: ${last.timestamp},${last.symbol},${last.action},${last.price},${last.quantity},"${last.reason.slice(0, 60)}…",${last.mode},${last.outcome},${last.pnl}`);
  }
  const skippedTags = [...new Set(skipped.map((x) => x.setup.setupTag))];
  for (const tag of skippedTags) {
    for (const lesson of lessonsFor(tag)) console.log(`Learnings note: ${lesson}`);
  }

  logTrial('replay:memory (raw baseline)', false, candles, all, rawStats, 'baseline computed inside replay:memory for comparison');
  logTrial('replay:memory', true, candles, taken, memStats, `${skippedCompleted.length} completed setups skipped by memory`);
  console.log(`Trials: both looks (raw baseline + memory-enabled) disclosed in ${trialsPath()} — ${trialCount()} configuration test(s) recorded to date.`);
}
