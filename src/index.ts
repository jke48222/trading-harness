import { runScan } from './bot';
import { runReplayMemory, runReplayRaw } from './replay';
import { learningsPath, ledgerPath, loadLedger, resetMemory } from './memory';
import { scoreMaturedScanTrades } from './scoring';
import { trialsPath } from './trials';
import { brokerCheck, brokerPreview } from './broker/alpaca';
import { getBrokerPositions } from './broker/orders';
import { CONFIG, validateConfig } from './config';
import { runHealth } from './health';
import { runReport } from './report';
import { runPerf } from './perf';
import { runReconcile } from './reconcileRun';

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
    case 'report':
      await runReport();
      break;
    case 'reconcile':
      await runReconcile(process.argv.includes('--apply'));
      break;
    case 'perf':
      await runPerf();
      break;
    case 'broker:check':
      await brokerCheck();
      break;
    case 'broker:preview':
      await brokerPreview();
      break;
    default:
      console.log('Usage:');
      console.log('  npm run scan            one live decision cycle on real public data (paper only; scores matured trades first)');
      console.log('  npm run score           score open trades whose exit has printed (horizon or state flip; real candles only)');
      console.log('  npm run positions       open paper positions and budget use');
      console.log('  npm run report          the book from broker fills: round trips, model vs actual, fees, per symbol');
      console.log('  npm run perf            account return, drawdown and volatility against BTC, SPY and the universe held equally');
      console.log('  npm run reconcile       compare broker fills with the ledger (add -- --apply to repair what the broker proves)');
      console.log('  npm run health          agents, orders, positions and regime; exits 2 on a problem it has posted, 1 if it could not post');
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
