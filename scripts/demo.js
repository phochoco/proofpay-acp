// Headless run of the whole protocol, auto-approving each hold. Useful as a smoke test:
//   npm run demo
import '../src/env.js';
import { createPayPal } from '../src/paypal.js';
import { Orchestrator } from '../src/orchestrator.js';

const paypal = createPayPal();
if (paypal.mode !== 'mock') {
  console.log('Sandbox credentials found: the headless demo cannot click "approve" in PayPal for you. Run `npm start` instead.');
  process.exit(0);
}
let last = 0;
const handled = new Set();
const orch = new Orchestrator({
  paypal, baseUrl: 'http://localhost:3000', maxOrderUsd: Number(process.env.MAX_ORDER_USD || 1500), delayMs: 0,
  onChange: (snap) => {
    for (const m of snap.ledger.slice(last)) console.log(`#${String(m.seq).padStart(2, '0')} ${m.phase.padEnd(11)} ${m.type.padEnd(16)} ${m.from} -> ${m.to}\n     ${m.content}`);
    last = snap.ledger.length;
    for (const j of snap.run?.jobs ?? []) {
      if (j.escrow?.status === 'AWAITING_BUYER_APPROVAL' && !handled.has(j.escrow.orderId)) {
        const id = j.escrow.orderId;
        handled.add(id);
        setImmediate(() => { paypal.approve(id); orch.resolveApproval(id, true); });
      }
    }
  },
});
const snap = await orch.run({
  text: 'NCR carbonless receipt book, A5, 3-part, 50 sets per book',
  quantity: Number(process.argv[2] || 500), maxUnitPrice: Number(process.argv[3] || 2), deadlineDays: 14, strategy: process.argv[4] || 'price',
});
console.log('\nOUTCOME:', snap.run.error ? `ERROR ${snap.run.error}` : snap.run.outcome.summary);
console.log('Escrow states:', snap.run.jobs.map((j) => `${j.provider}=${j.escrow?.status ?? '-'}/${j.phase}`).join('  '));
console.log('Ledger hash chain valid:', snap.ledgerValid, '| reputations:', '\n' + snap.agents.filter((a) => a.role === 'provider').sort((a, b) => a.rank - b.rank).map((a) => `  #${a.rank} ${a.name.padEnd(20)} trust ${Math.round(a.trust * 100)}  ${a.passed}/${a.jobs}`).join('\n'));
