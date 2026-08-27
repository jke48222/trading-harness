import { runScan } from './bot';
import { runReplayMemory, runReplayRaw } from './replay';
import { learningsPath, ledgerPath, loadLedger, resetMemory } from './memory';
import { scoreMaturedScanTrades } from './scoring';
import { trialsPath } from './trials';
import { brokerCheck, brokerPreview } from './broker/alpaca';
import { getBrokerPositions } from './broker/orders';
import { CONFIG, validateConfig } from './config';
import { runHealth } from './health';

const command = process.argv[2];

async function main(): Promise<void> {
  validateConfig();
  switch (command) {
    case 'scan':
      await runScan();
      break;
    case 'score':
      await scoreMaturedScanTrades();
      break;
    case 'health':
      await runHealth();
      break;
    case 'replay:raw':
      await runReplayRaw();
      break;
    case 'replay:memory':
      await runReplayMemory();
      break;
    case 'memory:reset':
      resetMemory();
      console.log(
        `Memory reset: ${ledgerPath()} re-created with header only, ${learningsPath()} re-created empty. ` +
          'No fake history was seeded.'
      );
      console.log(
        `Trials ledger ${trialsPath()} was NOT touched — trade memory is re-learnable, the count of looks is not.`
      );
      break;
    case 'positions': {
      const positions = await getBrokerPositions();
      if (positions.length === 0) {
        console.log('No open paper positions on the Alpaca PAPER account.');
      } else {
        let deployed = 0;
        for (const p of positions) {
          deployed += Math.abs(Number(p.market_value));
          console.log(
            `${p.symbol.padEnd(10)} qty ${p.qty} · entry ${p.avg_entry_price} · now ${p.current_price} · value $${Number(p.market_value).toFixed(2)} · unrealized ${Number(p.unrealized_pl) >= 0 ? '+' : ''}$${Number(p.unrealized_pl).toFixed(2)}`
          );
        }
        console.log(`Deployed $${deployed.toFixed(2)} of the $${CONFIG.budgetUsd} practice budget (${positions.length}/${CONFIG.maxOpenPositions} positions).`);
      }
      break;
    }
    case 'report': {
      interface Agg {
        n: number;
        total: number;
        wins: number;
      }
      const actual = new Map<string, Agg>();
      const model = new Map<string, Agg>();
      const add = (m: Map<string, Agg>, sym: string, pnl: number): void => {
        const a = m.get(sym) ?? { n: 0, total: 0, wins: 0 };
        a.n++;
        a.total += pnl;
        if (pnl > 0) a.wins++;
        m.set(sym, a);
      };
      for (const r of loadLedger()) {
        const pnl = Number(r.pnl);
        if (r.pnl === '' || !Number.isFinite(pnl)) continue;
        if (r.mode === 'alpaca-paper-exit') add(actual, r.symbol, pnl);
        if (r.mode === 'alpaca-paper' && ['win', 'loss', 'flat'].includes(r.outcome)) add(model, r.symbol, pnl);
      }
      console.log('Per-symbol book — ACTUAL = real paper fills (gross of fees) · MODEL = signal-close scoring at FEE_BPS:');
      const syms = [...new Set([...actual.keys(), ...model.keys()])].sort(
        (a, b) => (actual.get(b)?.total ?? -Infinity) - (actual.get(a)?.total ?? -Infinity)
      );
      if (syms.length === 0) console.log('  No completed round trips yet — entries are open or pending.');
      for (const s of syms) {
        const a = actual.get(s);
        const m = model.get(s);
        console.log(
          `  ${s.padEnd(11)} actual: ${a ? `${a.n} trips · total ${a.total >= 0 ? '+' : ''}${a.total.toFixed(2)}% · wins ${a.wins}/${a.n}` : '—'.padEnd(8)} · model: ${m ? `${m.n} scored · total ${m.total >= 0 ? '+' : ''}${m.total.toFixed(2)}%` : '—'}`
        );
      }
      console.log('Small samples rank noise, not skill — a symbol needs dozens of trips before "best" means anything (Trial 06).');
      const positions = await getBrokerPositions();
      let deployed = 0;
      for (const p of positions) deployed += Math.abs(Number(p.market_value));
      console.log(`Open now: ${positions.length} positions · $${deployed.toFixed(2)} deployed of $${CONFIG.budgetUsd} budget.`);
      break;
    }
    case 'broker:check':
      await brokerCheck();
      break;
    case 'broker:preview':
      await brokerPreview();
      break;
    default:
      console.log('Usage:');
      console.log('  npm run scan            one live decision cycle on real public data (paper only; scores matured trades first)');
      console.log('  npm run score           score open scan trades whose 12-candle horizon has passed (real outcomes only)');
      console.log('  npm run replay:raw      honest baseline over real history, memory ignored; seeds memory from real outcomes');
      console.log('  npm run replay:memory   same window with memory consulted; prints raw-vs-memory comparison');
      console.log('  npm run memory:reset    wipe ledger.csv and learnings.md back to empty');
      console.log('  npm run broker:check    read-only smoke test of the Alpaca PAPER account (no orders)');
      console.log('  npm run broker:preview  DRY RUN — print the order the bot WOULD place; nothing is sent');
      process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  console.error(`BLOCKED: ${(err as Error).message}`);
  console.error('The bot stops rather than faking a result. Fix the blocker above and re-run.');
  process.exitCode = 1;
});
