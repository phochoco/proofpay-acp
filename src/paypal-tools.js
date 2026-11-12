// Agents that act on PayPal through PayPal's own Agent Toolkit (@paypal/agent-toolkit).
//
// The toolkit ships PayPal operations as tools with a description, a zod schema and an execute
// function. We hand a small, task-specific subset of those tools to Claude and let the model decide
// which to call and with what arguments. The escrow itself (authorize / capture / void) stays in
// src/paypal.js, because the toolkit has no authorize or void tool and money movement must not
// depend on a model's choice.
//
// Only active with PayPal sandbox credentials and an Anthropic key. Otherwise every function
// returns null and the protocol runs exactly as before.
import { env } from './env.js';
import { llmInfo } from './llm.js';

let toolkitTools = null;

export async function initPayPalTools() {
  const clientId = env('PAYPAL_CLIENT_ID'), clientSecret = env('PAYPAL_CLIENT_SECRET');
  if (!clientId || !clientSecret || llmInfo.provider !== 'anthropic') return false;
  try {
    const [{ PayPalAgentToolkit }, { zodToJsonSchema }] = await Promise.all([
      import('@paypal/agent-toolkit/ai-sdk'), import('zod-to-json-schema'),
    ]);
    const toolkit = new PayPalAgentToolkit({
      clientId, clientSecret,
      configuration: {
        actions: { orders: { get: true }, invoices: { create: true, recordPayment: true } },
        context: { sandbox: true },
      },
    });
    toolkitTools = Object.fromEntries(Object.entries(toolkit.getTools()).map(([name, t]) => [name, {
      name, description: String(t.description || '').trim().slice(0, 1500),
      input_schema: (({ $schema, ...rest }) => rest)(zodToJsonSchema(t.parameters)),
      execute: (args) => t.execute(args, {}),
    }]));
    return true;
  } catch (err) {
    console.warn(`[paypal-tools] Agent Toolkit unavailable: ${err.message}`);
    toolkitTools = null;
    return false;
  }
}

export const toolsActive = () => Boolean(toolkitTools);

const asObject = (out) => {
  if (out && typeof out === 'object') return out;
  try { return JSON.parse(out); } catch { return { text: String(out) }; }
};

/**
 * A Claude tool-use loop over a subset of the toolkit's tools.
 * Returns the model's final JSON plus a log of every tool call it made.
 */
async function runAgent({ system, user, allowed, maxSteps = 5 }) {
  const tools = allowed.map((n) => toolkitTools[n]).filter(Boolean);
  const messages = [{ role: 'user', content: user }];
  const calls = [];
  for (let step = 0; step < maxSteps; step += 1) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': env('ANTHROPIC_API_KEY'), 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: llmInfo.model, max_tokens: 1200, system, tools: tools.map(({ execute, ...t }) => t), messages }),
    });
    if (!res.ok) throw new Error(`Anthropic ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const msg = await res.json();
    messages.push({ role: 'assistant', content: msg.content });
    const uses = msg.content.filter((b) => b.type === 'tool_use');
    if (msg.stop_reason !== 'tool_use' || !uses.length) {
      const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
      const s = text.indexOf('{'), e = text.lastIndexOf('}');
      let final = {};
      try { if (s >= 0 && e > s) final = JSON.parse(text.slice(s, e + 1)); } catch {}
      return { final, calls };
    }
    const results = [];
    for (const u of uses) {
      let output, ok = true;
      try { output = asObject(await toolkitTools[u.name].execute(u.input)); }
      catch (err) { ok = false; output = { error: err.message }; }
      calls.push({ tool: u.name, input: u.input, ok, output });
      console.log(`[paypal-tools] ${u.name} ${ok ? 'ok' : 'failed'} ${JSON.stringify(ok ? Object.keys(output).slice(0, 6) : output).slice(0, 300)}`);
      results.push({ type: 'tool_result', tool_use_id: u.id, content: JSON.stringify(output).slice(0, 6000), is_error: !ok });
    }
    messages.push({ role: 'user', content: results });
  }
  return { final: {}, calls };
}

/** Pull the hold out of a get_order response, whatever shape the toolkit returned. */
function holdFrom(order) {
  const unit = order?.purchase_units?.[0];
  const auth = unit?.payments?.authorizations?.[0];
  return {
    status: auth?.status || order?.status || 'UNKNOWN',
    amount: Number(auth?.amount?.value ?? unit?.amount?.value ?? NaN),
    payerEmail: order?.payer?.email_address || null,
  };
}

/**
 * Evaluator agent: before judging a delivery, confirm with PayPal that the buyer's money really
 * is held for the agreed amount. The pass/fail on the hold is computed from PayPal's own response,
 * not from the model's summary.
 */
export async function verifyHold({ evaluatorName, orderId, total }) {
  if (!toolkitTools) return null;
  try {
    const { final, calls } = await runAgent({
      system: `You are ${evaluatorName}, an independent evaluator agent. Before you judge a delivery you confirm on PayPal that the buyer's money is held. `
        + 'Use the get_order tool. Then reply with one JSON object: {"note": one sentence on what PayPal reports}.',
      user: `PayPal order ${orderId} should hold exactly ${total.toFixed(2)} USD, authorized but not captured. Check it.`,
      allowed: ['get_order'],
    });
    let call = calls.find((c) => c.tool === 'get_order' && c.ok);
    let source = 'llm';
    if (!call) { // the model did not call the tool; the evaluator still checks, but says so
      const output = asObject(await toolkitTools.get_order.execute({ id: orderId }));
      call = { tool: 'get_order', input: { id: orderId }, ok: true, output };
      source = 'scripted';
    }
    const hold = holdFrom(call.output);
    const pass = ['CREATED', 'AUTHORIZED'].includes(hold.status) && Math.abs(hold.amount - total) < 0.01;
    return {
      pass, ...hold, source, toolCalls: calls.length || 1,
      note: String(final.note || `PayPal reports the order ${hold.status === 'CREATED' ? 'authorized' : hold.status.toLowerCase()} for ${hold.amount.toFixed(2)} USD.`).slice(0, 300),
    };
  } catch (err) {
    console.warn(`[paypal-tools] verifyHold: ${err.message}`);
    return null;
  }
}

/**
 * Supplier agent: once paid, it issues a PayPal invoice for the job and records the payment on it,
 * so the buyer's books get a proper invoice instead of a bare transfer.
 */
export async function invoiceForJob({ supplierName, payerEmail, item, quantity, unitPrice, total, captureId }) {
  if (!toolkitTools) return null;
  if (!payerEmail) { console.warn('[paypal-tools] invoiceForJob: no payer email from PayPal, skipping'); return null; }
  const today = new Date().toISOString().slice(0, 10);
  try {
    const { final, calls } = await runAgent({
      system: `You are the sales agent of ${supplierName}. You were just paid through PayPal for a job. Keep the buyer's books clean: `
        + 'first create a PayPal invoice for the job, then record the payment you already received against that invoice '
        + `(method PAYPAL, date ${today}, the full amount). Do not send the invoice. `
        + 'Finish with one JSON object: {"invoice_id": string, "note": one sentence for the buyer}.',
      user: JSON.stringify({ recipient_email: payerEmail, currency: 'USD', item_name: item, quantity, unit_amount: unitPrice.toFixed(2),
        total: total.toFixed(2), paypal_capture_id: captureId, note_to_buyer: `Paid through PayPal after delivery verification. Capture ${captureId}.` }),
      allowed: ['create_invoice', 'record_payment_for_invoice'],
      maxSteps: 6,
    });
    const created = calls.find((c) => c.tool === 'create_invoice' && c.ok);
    const idFromCall = created && (created.output.id || created.output.href?.split('/').pop() || created.output.links?.[0]?.href?.split('/').pop());
    const invoiceId = idFromCall || final.invoice_id || null;
    if (!invoiceId) {
      console.warn(`[paypal-tools] invoiceForJob: no invoice id after ${calls.length} calls. Last: ${JSON.stringify(calls.at(-1)?.output || final).slice(0, 400)}`);
      return { ok: false, calls: calls.length, note: 'The supplier agent tried to issue a PayPal invoice but PayPal did not accept it.' };
    }
    const recorded = calls.some((c) => c.tool === 'record_payment_for_invoice' && c.ok);
    return { ok: true, invoiceId, recorded, calls: calls.length, note: String(final.note || '').slice(0, 240) };
  } catch (err) {
    console.warn(`[paypal-tools] invoiceForJob: ${err.message}`);
    return null;
  }
}
