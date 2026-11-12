import http from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { env, ROOT } from './env.js';
import { createPayPal } from './paypal.js';
import { Orchestrator } from './orchestrator.js';
import { llmInfo } from './llm.js';
import { initPayPalTools } from './paypal-tools.js';

const toolkitOn = paypalToolsReady();
async function paypalToolsReady() { return initPayPalTools(); }

const PORT = Number(env('PORT', '3000'));
// On Render the public address is provided as RENDER_EXTERNAL_URL; PayPal sends the buyer back there.
const BASE_URL = env('RENDER_EXTERNAL_URL') || env('BASE_URL') || `http://localhost:${PORT}`;
// A public demo should not let one visitor run up the AI bill: cap new orders per hour.
const RUNS_PER_HOUR = Number(env('RUNS_PER_HOUR', '30'));
const runTimes = [];
const clients = new Set();

const paypal = createPayPal();
const orch = new Orchestrator({
  paypal,
  baseUrl: BASE_URL,
  maxOrderUsd: Number(env('MAX_ORDER_USD', '1500')),
  delayMs: Number(env('STEP_DELAY_MS', '700')),
  payeeEmail: env('SUPPLIER_PAYEE_EMAIL') || undefined,
  evaluatorPayeeEmail: env('EVALUATOR_PAYEE_EMAIL') || undefined,
  historyFile: join(ROOT, 'data', 'network.json'),
  onChange: (snap) => {
    const frame = `data: ${JSON.stringify(snap)}\n\n`;
    for (const res of clients) res.write(frame);
  },
});

orch.startAmbient(Number(env('AMBIENT_MS', '3500')));

const send = (res, status, body, type = 'application/json') => {
  res.writeHead(status, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-store' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
};
const readBody = (req) => new Promise((resolve, reject) => {
  let data = '';
  req.on('data', (c) => { data += c; if (data.length > 1e5) reject(new Error('body too large')); });
  req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
});
const page = (title, body) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>@font-face{font-family:Jakarta;src:url(/fonts/jakarta.woff2) format("woff2-variations");font-weight:200 800}
body{font:16px/1.55 Jakarta,Arial,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;background:#f3f5f9;color:#0b1a3a}
main{max-width:440px;margin:20px;padding:30px;background:#fff;border:1px solid #dde3ee;border-radius:20px}
h2{font-size:24px;line-height:1.2;font-weight:750;letter-spacing:-.02em;margin:0 0 10px}
a.act{display:inline-block;padding:13px 26px;background:#001c64;color:#fff;border-radius:999px;text-decoration:none;font-weight:750}
.flag{display:inline-block;background:#fff4c7;color:#6b5200;padding:3px 10px;border-radius:999px;font-size:13px;font-weight:700;margin:0 0 12px}</style>
<body><main>${body}</main></body>`;
const backToApp = '<script>setTimeout(function(){ if (window.opener) window.close(); else location.href = "/"; }, 1200)</script>';

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, BASE_URL);
  try {
    // Uptime monitors send HEAD as well as GET; this keeps the free instance awake.
    if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname === '/health') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end(req.method === 'HEAD' ? undefined : 'ok');
    }
    if (req.method === 'GET' && url.pathname === '/') return send(res, 200, readFileSync(join(ROOT, 'public/index.html'), 'utf8'), 'text/html');
    if (url.pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
    if (req.method === 'GET' && /^\/fonts\/[\w-]+\.woff2$/.test(url.pathname)) {
      res.writeHead(200, { 'content-type': 'font/woff2', 'cache-control': 'public, max-age=86400' });
      return res.end(readFileSync(join(ROOT, 'public', url.pathname)));
    }
    if (req.method === 'GET' && url.pathname === '/api/state') return send(res, 200, orch.snapshot());
    if (req.method === 'GET' && url.pathname === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write(`data: ${JSON.stringify(orch.snapshot())}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/run') {
      if (orch.busy) return send(res, 409, { error: 'Another order is running right now. Try again in a minute.' });
      const hourAgo = Date.now() - 3600e3;
      while (runTimes.length && runTimes[0] < hourAgo) runTimes.shift();
      if (runTimes.length >= RUNS_PER_HOUR) return send(res, 429, { error: `This demo allows ${RUNS_PER_HOUR} orders an hour. Try again later.` });
      runTimes.push(Date.now());
      const input = await readBody(req);
      orch.run(input); // progress is streamed over /events
      return send(res, 202, { started: true });
    }
    if (req.method === 'POST' && url.pathname === '/api/reset') {
      if (orch.busy) return send(res, 409, { error: 'A run is in progress.' });
      orch.reset();
      return send(res, 200, { ok: true });
    }

    if (req.method === 'POST' && url.pathname === '/api/reset-network') {
      if (orch.busy) return send(res, 409, { error: 'A run is in progress.' });
      orch.resetNetwork();
      return send(res, 200, { ok: true });
    }

    if (req.method === 'POST' && url.pathname === '/api/ambient') {
      orch.setAmbient((await readBody(req)).on);
      return send(res, 200, { ok: true });
    }

    // PayPal sends the human back here after they approve (or cancel) the hold.
    if (req.method === 'GET' && (url.pathname === '/paypal/return' || url.pathname === '/paypal/cancel')) {
      const approved = url.pathname === '/paypal/return';
      const known = orch.resolveApproval(url.searchParams.get('token'), approved);
      const msg = !known ? 'This approval link is no longer active.' : approved ? 'Hold approved. The agents are continuing.' : 'Hold cancelled. No money moved.';
      return send(res, 200, page('ProofPay ACP', `<h2>${msg}</h2><p>Returning to the app.</p>${backToApp}`), 'text/html');
    }

    // Mock-only stand-in for the PayPal approval screen.
    if (req.method === 'GET' && url.pathname === '/mock-paypal/approve' && paypal.mode === 'mock') {
      const token = url.searchParams.get('token') || '';
      const order = paypal.orders.get(token);
      if (!order) return send(res, 404, page('Mock', '<h2>Unknown mock order</h2>'), 'text/html');
      if (url.searchParams.get('decision') === 'approve') {
        paypal.approve(token);
        res.writeHead(302, { location: `/paypal/return?token=${encodeURIComponent(token)}` });
        return res.end();
      }
      const t = encodeURIComponent(token);
      return send(res, 200, page('Mock approval', `<p class="flag">Mock mode. This is not PayPal.</p>
        <h2>Approve a hold of $${order.amount}?</h2><p>This stands in for the buyer approving the hold in PayPal. No real or sandbox money is involved.</p>
        <p><a class="act" href="/mock-paypal/approve?token=${t}&decision=approve">Approve hold</a></p>
        <p><a href="/paypal/cancel?token=${t}" style="color:inherit">Cancel the hold</a></p>`), 'text/html');
    }
    send(res, 404, { error: 'not found' });
  } catch (err) {
    console.error(err);
    send(res, 500, { error: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`ProofPay ACP  ->  ${BASE_URL}`);
  console.log(`  PayPal : ${paypal.mode === 'sandbox' ? 'SANDBOX (api-m.sandbox.paypal.com)' : 'MOCK (set PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET for sandbox)'}`);
  console.log(`  Agents : ${llmInfo.provider === 'scripted' ? 'SCRIPTED (set ANTHROPIC_API_KEY or OPENAI_API_KEY for AI agents)' : `${llmInfo.provider} / ${llmInfo.model}`}`);
  toolkitOn.then((on) => console.log(`  Toolkit: ${on ? `PayPal Agent Toolkit active: get_order${process.env.TOOLKIT_INVOICES === 'on' ? ', create_invoice, record_payment_for_invoice' : ''}` : 'off (needs PayPal sandbox + Anthropic key)'}`));
});
