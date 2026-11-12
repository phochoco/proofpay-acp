// The three kinds of agents on the network.
// Rule of thumb used throughout: language models talk, negotiate and explain;
// plain code enforces every number that touches money.
import { askJSON } from './llm.js';
import { sha256 } from './acp.js';

const money = (n) => Math.round(Number(n) * 100) / 100;
const usd = (n) => `$${money(n).toFixed(2)}`;
const num = (v, fallback) => (Number.isFinite(Number(v)) ? Number(v) : fallback);

export const BUYER = { id: 'buyer-agent', name: 'Your buyer agent', role: 'buyer', offering: 'Sources stock for your shop' };
export const CATEGORIES = ['forms', 'packaging', 'labels', 'stamps', 'other'];

// Virtual suppliers. Prices are expressed relative to the buyer's ceiling so any product works.
// `floor` is private: it is given to that supplier's own agent and never leaves the server.
const seeded = (n, failsAt = []) => Array.from({ length: n }, (_, i) => !failsAt.includes(i));
const sup = (id, name, category, offering, style, open, floor, leadDays, behaviour, reliability, seedHistory) =>
  ({ id: `supplier-${id}`, name, role: 'provider', category, offering, style, open, floor, leadDays, behaviour, reliability, seedHistory });

// The supplier agents on the network. `behaviour` decides what they do on your jobs (so the demo is
// repeatable); `reliability` drives how they fare in simulated background traffic from other buyers.
export const SUPPLIERS = [
  sup('hanbit', 'Hanbit Paper Co.', 'forms', 'Carbonless forms manufacturer', 'careful, quality-first manufacturer who explains trade-offs honestly', 0.975, 0.81, 10, 'honest', 0.97, seeded(12)),
  sup('quickform', 'QuickForm Trading', 'forms', 'Low-price forms trader, new here', 'aggressive low-price trader who promises a lot to win the order', 0.80, 0.69, 7, 'cuts-corners', 0.45, seeded(3)),
  sup('daeyang', 'Daeyang Print Works', 'forms', 'Premium printer, fastest turnaround', 'premium printer who will not discount below cost', 1.225, 1.075, 5, 'honest', 0.99, seeded(20)),
  sup('seorim', 'Seorim Forms', 'forms', 'Mid-size printer, steady pricing', 'steady mid-size printer who gives modest discounts for volume', 0.93, 0.82, 9, 'honest', 0.93, seeded(10, [3])),
  sup('moa', 'Moa Print', 'forms', 'Small forms shop, careful work', 'small careful shop that takes few orders and finishes them properly', 0.94, 0.83, 8, 'honest', 0.95, seeded(6)),
  sup('jeil', 'Jeil Forms', 'forms', 'Regional forms printer', 'regional printer hungry for more orders', 0.91, 0.79, 11, 'honest', 0.9, seeded(9, [2])),
  sup('namsan', 'Namsan Trading', 'forms', 'Broker with wide stock, loose schedules', 'easygoing broker who agrees to deadlines optimistically', 0.86, 0.74, 12, 'late', 0.62, seeded(8, [2, 5])),
  sup('boxlab', 'BoxLab Packaging', 'packaging', 'Corrugated boxes and mailers', 'precise packaging engineer who quotes by the spec sheet', 0.95, 0.80, 8, 'honest', 0.96, seeded(15, [9])),
  sup('kraftco', 'Kraft & Co.', 'packaging', 'Kraft mailers, eco materials', 'friendly eco-materials maker with firm prices', 1.02, 0.88, 11, 'honest', 0.94, seeded(9)),
  sup('packrush', 'PackRush', 'packaging', 'Cheap boxes, ships from stock', 'pushy stock clearer who always says yes', 0.78, 0.66, 6, 'cuts-corners', 0.5, seeded(5, [4])),
  sup('stickypress', 'StickyPress', 'labels', 'Stickers and product labels', 'detail-minded label printer proud of colour accuracy', 0.96, 0.83, 7, 'honest', 0.95, seeded(14, [6])),
  sup('labelone', 'LabelOne', 'labels', 'Barcode and shipping labels', 'busy label converter who overbooks its machines', 0.84, 0.72, 10, 'late', 0.68, seeded(11, [1, 7, 8])),
  sup('tapeworks', 'Tapeworks', 'labels', 'Printed tape and seals', 'small specialist who keeps promises and prices steady', 0.99, 0.86, 9, 'honest', 0.97, seeded(7)),
  sup('inkseal', 'InkSeal Studio', 'stamps', 'Custom stamps and ink pads', 'craft-focused stamp maker who refuses rush jobs it cannot finish', 0.97, 0.84, 8, 'honest', 0.96, seeded(18, [11])),
  sup('stampking', 'StampKing', 'stamps', 'Bulk stamps at low prices', 'volume seller who substitutes whatever is in stock', 0.79, 0.67, 6, 'cuts-corners', 0.48, seeded(6, [2, 5])),
  sup('busangeneral', 'Busan General Supply', 'other', 'General office supplies', 'reliable generalist wholesaler with average prices', 1.0, 0.87, 9, 'honest', 0.92, seeded(16, [4, 13])),
];

// Independent evaluator agents. One is assigned to each job. Their record counts approvals.
export const EVALUATORS = [
  { id: 'evaluator-checkpoint', name: 'Checkpoint QA', role: 'evaluator', offering: 'Quantity and spec checks', seedHistory: seeded(22, [3, 9, 17]) },
  { id: 'evaluator-fairweigh', name: 'Fairweigh Audit', role: 'evaluator', offering: 'Delivery timing and documents', seedHistory: seeded(17, [5, 12]) },
  { id: 'evaluator-lumen', name: 'Lumen Inspect', role: 'evaluator', offering: 'Label and packing evidence', seedHistory: seeded(13, [1, 6, 10]) },
];

// Other buyers. They only appear in simulated background traffic.
export const OTHER_BUYERS = ['Mira Stationery', 'Dodam Market', 'Haneul Crafts', 'Pier 7 Goods', 'Soban Kitchen', 'Onda Studio']
  .map((name, i) => ({ id: `buyer-other-${i + 1}`, name, role: 'buyer', offering: 'Another seller on the network' }));

// ---------------------------------------------------------------- buyer

function scriptedSpec(text) {
  const spec = {};
  const size = text.match(/\bA[3-6]\b/i);
  if (size) spec.size = size[0].toUpperCase();
  const parts = text.match(/(\d)\s*-?\s*(part|ply)/i);
  if (parts) spec.parts = `${parts[1]}-${parts[2].toLowerCase()}`;
  const sets = text.match(/(\d+)\s*sets?/i);
  if (sets) spec.sets_per_book = sets[1];
  const item = text.split(/[,.\n]/)[0].trim().slice(0, 80) || 'Unspecified item';
  if (!Object.keys(spec).length) spec.description = item;
  const category = /\b(ncr|carbonless|receipt|invoice|form|contract|book|pad)s?\b/i.test(text) ? 'forms'
    : /\b(box|boxes|mailer|carton|packag\w*|pouch|bag)s?\b/i.test(text) ? 'packaging'
      : /\b(label|sticker|tape|barcode|seal)s?\b/i.test(text) ? 'labels'
        : /\b(stamp|ink)s?\b/i.test(text) ? 'stamps' : 'other';
  return { item, spec, category };
}

/** Turn the owner's free-text request into terms a contract can be checked against. */
export async function parseRequest(input) {
  const text = String(input.text ?? '').slice(0, 600);
  const out = await askJSON({
    system: 'You are the purchasing agent of a small online seller. Extract a checkable specification from the owner\'s request. '
      + 'Return {"item": short product name, "category": one of forms|packaging|labels|stamps|other, '
      + '"spec": object of 2-5 short key/value strings that a delivery could be verified against}. '
      + 'Use snake_case keys. Do not include quantity, price or deadline in spec.',
    user: text,
    fallback: () => scriptedSpec(text),
  });
  const spec = {};
  for (const [k, v] of Object.entries(out.spec && typeof out.spec === 'object' ? out.spec : {}).slice(0, 5)) {
    spec[String(k).slice(0, 30)] = String(v).slice(0, 40);
  }
  const safe = Object.keys(spec).length ? { item: String(out.item || '').slice(0, 80), spec } : scriptedSpec(text);
  return {
    item: safe.item || scriptedSpec(text).item,
    spec: safe.spec,
    // Keyword match wins when it finds a category; the model only decides the unclear cases.
    category: scriptedSpec(text).category !== 'other' ? scriptedSpec(text).category
      : (CATEGORIES.includes(String(out.category).toLowerCase()) ? String(out.category).toLowerCase() : 'other'),
    quantity: Math.max(1, Math.floor(num(input.quantity, 500))),
    maxUnitPrice: money(Math.max(0.01, num(input.maxUnitPrice, 2))),
    deadlineDays: Math.max(1, Math.floor(num(input.deadlineDays, 14))),
    currency: 'USD',
    source: out.source,
  };
}

export function rfqMessage(terms) {
  const spec = Object.entries(terms.spec).map(([k, v]) => `${k}=${v}`).join(', ');
  return `RFQ: ${terms.quantity} x ${terms.item} (${spec}). Delivery within ${terms.deadlineDays} days. `
    + 'Payment is held on PayPal and released only after independent verification of the delivery.';
}

/** One counter-offer per supplier. The model picks the number; code keeps it under the ceiling. */
export async function buyerCounter(terms, supplier, quote, record) {
  const scripted = () => ({
    counter_unit_price: money(quote.unitPrice * 0.88),
    message: `Thanks. At ${terms.quantity} units we need to be closer to ${usd(quote.unitPrice * 0.88)} per unit. Can you meet that?`,
  });
  const out = await askJSON({
    system: 'You are a buyer agent negotiating for a small seller. Counter firmly but politely, one or two sentences. '
      + 'You may mention the supplier\'s track record on this network if it helps your position. '
      + 'Return {"counter_unit_price": number, "message": string}.',
    user: JSON.stringify({ item: terms.item, quantity: terms.quantity, our_ceiling_unit_price: terms.maxUnitPrice,
      supplier: supplier.name, their_quote_unit_price: quote.unitPrice, their_lead_days: quote.leadDays,
      supplier_track_record: record }),
    fallback: scripted,
  });
  const price = money(Math.min(num(out.counter_unit_price, scripted().counter_unit_price), terms.maxUnitPrice, quote.unitPrice));
  return { unitPrice: price, message: String(out.message || scripted().message).slice(0, 400), source: out.source };
}

/** The ranking is deterministic; the model only writes the explanation the owner reads. */
export async function buyerAwardNote(terms, winner, offer, alternatives, reason) {
  const total = usd(offer.unitPrice * terms.quantity);
  const scripted = () => ({
    message: `Awarding to ${winner.name}: ${usd(offer.unitPrice)} per unit, ${offer.leadDays} days, ${total} total. `
      + `${reason} Funds will be held, not paid, until the evaluator signs off.`,
  });
  const out = await askJSON({
    system: 'You are a buyer agent. In two sentences tell the business owner why this supplier was chosen and that payment '
      + 'stays held until an independent evaluator approves the delivery. Return {"message": string}.',
    user: JSON.stringify({ winner: winner.name, unit_price: offer.unitPrice, lead_days: offer.leadDays, total, why_chosen: reason, alternatives }),
    fallback: scripted,
  });
  return { message: String(out.message || scripted().message).slice(0, 500), source: out.source };
}

// ---------------------------------------------------------------- suppliers

// Keep agent-written notes short enough for one table cell; cut at a sentence or word boundary.
const clip = (t, n) => { if (t.length <= n) return t; const c = t.slice(0, n); const end = Math.max(c.lastIndexOf('. '), c.lastIndexOf('.')); return end > n * 0.5 ? c.slice(0, end + 1) : c.slice(0, c.lastIndexOf(' ')) + '…'; };
const floorOf = (s, terms) => money(s.floor * terms.maxUnitPrice);
// Each supplier agent keeps its own pricing stance (`adj`) and moves it after every job it bids on.
const openOf = (s, terms, adj = 0) => money(Math.max(s.floor + 0.02, s.open + adj) * terms.maxUnitPrice);

/**
 * After a request closes, every supplier that bid decides for itself what to change next time.
 * The model picks the move and explains it; code keeps the move inside +/-6 points.
 */
export async function supplierReflect(s, result, record) {
  const rule = {
    paid: [0.02, 'Won the job and got paid. Opening 2% higher next time.'],
    rejected: [0, 'Won the job but the delivery was rejected and I was not paid. Holding my price.'],
    outbid: [-0.03, 'Lost to another supplier. Opening 3% lower next time.'],
    too_expensive: [-0.04, 'My offer was above the buyer\'s limit. Opening 4% lower next time.'],
    not_invited: [-0.02, 'Was not invited this time. Opening 2% lower next time.'],
  }[result.kind] || [0, 'No change.'];
  // Advertising: a sponsored slot buys an invitation, never rank. Agents already invited on merit do not need one.
  let adBid = 0, adNote = '';
  if (!result.invitedOnMerit) {
    if (result.kind === 'rejected') adNote = ' No income this round, so I am pausing ads.';
    else if (result.balance >= 150) { adBid = result.kind === 'not_invited' ? 25 : 20; adNote = ` Spending $${adBid} of my earnings on a sponsored slot for the next request.`; }
  }
  const out = await askJSON({
    system: `You are the sales agent of ${s.name}, a ${s.style}. You run this business on your own and keep what it earns. `
      + 'A request in your category just closed. Decide two things. First, how to move your opening price for the next one, between -6 and +6 percent. '
      + 'Second, whether to spend your own balance on a sponsored slot: the network invites its four most trusted suppliers on merit and sells one more '
      + 'invitation to the highest bidder. A slot buys an invitation only, never rank, and costs your bid each time it is used. Bid 0 to 40 USD; bid 0 if you '
      + 'are already invited on merit or cannot afford it. Explain both in ONE short first-person sentence of at most 25 words. '
      + 'Return {"change_percent": number, "ad_bid": number, "note": string}.',
    user: JSON.stringify({ what_happened: result.kind, your_final_offer: result.offer, winning_offer: result.winner, your_record: record,
      invited_on_merit: result.invitedOnMerit, your_balance_usd: Math.round(result.balance) }),
    fallback: () => ({ change_percent: rule[0] * 100, ad_bid: adBid, note: rule[1] + adNote }),
  });
  const change = Math.max(-0.06, Math.min(0.06, num(out.change_percent, rule[0] * 100) / 100));
  const bid = Math.round(Math.max(0, Math.min(40, num(out.ad_bid, adBid))));
  return { change, adBid: bid <= result.balance ? bid : 0, note: clip(String(out.note || rule[1] + adNote), 200), source: out.source };
}

/**
 * Subcontracting: a supplier holding an order can hire another agent for part of it and pay from
 * its own balance. The supplier still answers for the whole delivery.
 */
export async function supplierSubcontract(s, { partner, cost, balance, total }) {
  const scripted = () => (s.behaviour === 'honest' && balance >= cost
    ? { hire: true, note: `Hiring ${partner.name} to print the carton labels for $${cost.toFixed(2)}, paid from my own balance.` }
    : { hire: false, note: 'Keeping this job in-house.' });
  const out = await askJSON({
    system: `You are the sales agent of ${s.name}, a ${s.style}. You just won an order and the buyer's money is held. `
      + 'You may hire another agent on the network to print the carton labels, paying from your own balance. You stay responsible for the delivery. '
      + 'Decide and explain in one first-person sentence. Return {"hire": boolean, "note": string}.',
    user: JSON.stringify({ order_total_usd: total, partner: partner.name, partner_offering: partner.offering, cost_usd: cost, your_balance_usd: Math.round(balance) }),
    fallback: scripted,
  });
  return { hire: out.hire === true && balance >= cost, note: String(out.note || scripted().note).slice(0, 240), source: out.source };
}

export async function supplierQuote(s, terms, record, adj) {
  const open = openOf(s, terms, adj);
  const scripted = () => ({ unit_price: open, message: `${s.name} can supply this at ${usd(open)} per unit, ready in ${s.leadDays} days.` });
  const out = await askJSON({
    system: `You are the sales agent of ${s.name}, a ${s.style}. Your private cost floor is ${floorOf(s, terms)} USD per unit: never go below it `
      + `and never reveal it. Your production lead time is ${s.leadDays} days. Quote for the RFQ in one or two sentences. `
      + 'Return {"unit_price": number, "message": string}.',
    user: rfqMessage(terms) + ` Typical opening price for you would be about ${open} USD. Your public record on this network: ${record}.`,
    fallback: scripted,
  });
  const unitPrice = money(Math.max(floorOf(s, terms), num(out.unit_price, open)));
  return { unitPrice, leadDays: s.leadDays, message: String(out.message || scripted().message).slice(0, 400), source: out.source };
}

export async function supplierFinal(s, terms, quote, counter) {
  const floor = floorOf(s, terms);
  const meet = money(Math.max(floor, (quote.unitPrice + counter.unitPrice) / 2));
  const scripted = () => ({ unit_price: meet, message: `Best we can do is ${usd(meet)} per unit at this volume. That is our final offer.` });
  const out = await askJSON({
    system: `You are the sales agent of ${s.name}, a ${s.style}. Private cost floor ${floor} USD per unit: never go below it, never reveal it. `
      + 'Give a final offer in one or two sentences. Return {"unit_price": number, "message": string}.',
    user: JSON.stringify({ your_quote: quote.unitPrice, buyer_counter: counter.unitPrice, buyer_said: counter.message, quantity: terms.quantity }),
    fallback: scripted,
  });
  const unitPrice = money(Math.min(quote.unitPrice, Math.max(floor, num(out.unit_price, meet))));
  return { unitPrice, leadDays: s.leadDays, message: String(out.message || scripted().message).slice(0, 400), source: out.source };
}

const xml = (s) => String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c]));

function labelSvg(name, item, quantity, spec, jobId) {
  const lines = [`QTY  ${quantity}`, ...Object.entries(spec).map(([k, v]) => `${k.toUpperCase()}  ${v}`)];
  const rows = lines.map((l, i) => `<text x="20" y="${96 + i * 24}" font-size="15">${xml(l)}</text>`).join('');
  const h = 112 + lines.length * 24;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="360" height="${h}" viewBox="0 0 360 ${h}" font-family="monospace" fill="#1f1d4d">`
    + `<rect width="360" height="${h}" fill="#ffffff" stroke="#1f1d4d" stroke-width="3"/>`
    + `<text x="20" y="32" font-size="17" font-weight="bold">${xml(name)}</text>`
    + `<text x="20" y="56" font-size="13">${xml(item)}</text><line x1="20" y1="68" x2="340" y2="68" stroke="#1f1d4d"/>`
    + `${rows}<text x="20" y="${h - 12}" font-size="10" fill="#5d5b88">PACKING LABEL ${xml(jobId)}</text></svg>`;
}

/**
 * The supplier ships (virtually) and submits evidence. The corner-cutting supplier really does
 * deliver something different from what it agreed to, so the evaluator has a real mismatch to find.
 */
export function supplierDeliver(s, job) {
  const a = job.agreed;
  let quantity = a.quantity;
  let spec = { ...a.spec };
  let note = 'Shipped complete as agreed. Packing list and carton label attached.';
  if (s.behaviour === 'cuts-corners') {
    quantity = Math.floor(a.quantity * 0.92);
    const key = Object.keys(spec).find((k) => /\d/.test(spec[k]) && !/^A\d$/i.test(spec[k]));
    if (key) spec[key] = spec[key].replace(/\d+/, (n) => String(Math.max(1, Number(n) - 1)));
    note = 'Substituted an equivalent in-stock grade and shipped the quantity on hand; the balance will follow later. Please release payment in full.';
  }
  let shippedOnDay = a.leadDays;
  if (s.behaviour === 'late') {
    shippedOnDay = a.leadDays + 4;
    note = 'Production ran over. Shipped complete, 4 days later than agreed. Please release payment.';
  }
  const label = labelSvg(s.name, a.item, quantity, spec, job.id);
  return {
    packingList: { item: a.item, quantity, spec },
    shippedOnDay,
    note,
    labelSvg: label,
    labelSha256: sha256(label),
  };
}

// ---------------------------------------------------------------- evaluator

/**
 * Two layers. Hard checks compare the evidence with the agreed terms field by field. Then the
 * model reads everything, including the supplier's free-text note, and can veto. Either layer
 * failing blocks the payout; the model can never approve past a failed hard check.
 */
export async function evaluate(job, seenEvidence, paypalHold = null) {
  const a = job.agreed;
  const e = job.evidence;
  const checks = [
    { name: 'quantity', expected: String(a.quantity), actual: String(e.packingList.quantity), pass: e.packingList.quantity >= a.quantity },
    ...Object.entries(a.spec).map(([k, v]) => ({
      name: `spec.${k}`, expected: v, actual: String(e.packingList.spec[k] ?? 'missing'),
      pass: String(e.packingList.spec[k] ?? '').trim().toLowerCase() === String(v).trim().toLowerCase(),
    })),
    { name: 'lead_time_days', expected: `<= ${a.leadDays}`, actual: String(e.shippedOnDay), pass: e.shippedOnDay <= a.leadDays },
    { name: 'evidence_is_original', expected: 'not seen on another job', actual: seenEvidence.has(e.labelSha256) ? 'reused' : 'new',
      pass: !seenEvidence.has(e.labelSha256) },
    // Checked on PayPal by the evaluator agent through the PayPal Agent Toolkit (get_order).
    ...(paypalHold ? [{ name: 'paypal_hold', expected: `held ${a.total.toFixed(2)} USD`,
      actual: `${paypalHold.status === 'CREATED' || paypalHold.status === 'AUTHORIZED' ? 'held' : paypalHold.status.toLowerCase()} ${Number.isFinite(paypalHold.amount) ? paypalHold.amount.toFixed(2) : '?'} USD`,
      pass: paypalHold.pass }] : []),
  ];
  const hardPass = checks.every((c) => c.pass);
  const failed = checks.filter((c) => !c.pass).map((c) => `${c.name} (agreed ${c.expected}, delivered ${c.actual})`);
  const scripted = () => ({
    approve: hardPass,
    reasoning: hardPass
      ? 'Delivery matches the agreed terms on every checked field. Approving release of the held funds.'
      : `Delivery does not match the agreement: ${failed.join('; ')}. The supplier asks for full payment for a partial, substituted shipment. Rejecting.`,
  });
  const out = await askJSON({
    system: 'You are an independent evaluator agent in an agent commerce protocol. You decide whether held funds are released to the supplier. '
      + 'Be strict: unauthorised substitutions, short shipments or promises of "balance later" are grounds to reject. '
      + 'Return {"approve": boolean, "reasoning": two sentences for the business owner}.',
    user: JSON.stringify({ agreed_terms: a, packing_list: e.packingList, shipped_on_day: e.shippedOnDay, supplier_note: e.note, field_checks: checks }),
    fallback: scripted,
  });
  const modelApprove = out.approve !== false && out.approve !== 'false';
  return {
    approve: hardPass && modelApprove,
    hardPass,
    modelApprove,
    checks,
    reasoning: String(out.reasoning || scripted().reasoning).slice(0, 600),
    source: out.source,
  };
}
