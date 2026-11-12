// Runs one procurement request through the protocol and owns all state the UI shows.
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { Ledger, Registry, Job, EVALUATION_FEE, BUYER_COMMISSION } from './acp.js';
import { toolsActive, verifyHold, invoiceForJob } from './paypal-tools.js';
import { llmInfo } from './llm.js';
import {
  BUYER, EVALUATORS, OTHER_BUYERS, SUPPLIERS, parseRequest, rfqMessage, buyerCounter, buyerAwardNote,
  supplierQuote, supplierFinal, supplierDeliver, supplierReflect, supplierSubcontract, evaluate,
} from './agents.js';

const money = (n) => Math.round(Number(n) * 100) / 100;
const usd = (n) => `$${money(n).toFixed(2)}`;

export class Orchestrator {
  constructor({ paypal, baseUrl, maxOrderUsd, delayMs, payeeEmail, evaluatorPayeeEmail, onChange, historyFile }) {
    Object.assign(this, { paypal, baseUrl, maxOrderUsd, delayMs, payeeEmail, evaluatorPayeeEmail, historyFile });
    this.onChange = onChange || (() => {});
    this.pending = new Map(); // PayPal order id -> { resolve } while we wait for the human
    this.seenEvidence = new Set();
    this.buildRegistry();
    // Track records survive restarts, so rankings keep building from one request to the next.
    if (historyFile && existsSync(historyFile)) {
      try {
        const saved = JSON.parse(readFileSync(historyFile, 'utf8'));
        this.registry.import(saved.history);
        this.pricing = saved.pricing || {};
      } catch (err) { console.warn(`[history] ignored unreadable file: ${err.message}`); }
    }
    this.reset();
  }

  buildRegistry() {
    this.registry = new Registry();
    for (const a of [BUYER, ...OTHER_BUYERS, ...EVALUATORS, ...SUPPLIERS]) this.registry.register(a);
    this.activity = [];
    this.evaluatorTurn = 0;
    this.pricing = {}; // supplier id -> { adj, note, source }: each agent's own pricing stance
    // QuickForm starts with a sponsored slot already bought: thin record, low price, paying to be seen.
    this.registry.get('supplier-quickform').ad = { bid: 25, left: 1 };
  }

  save() {
    if (!this.historyFile) return;
    try { mkdirSync(dirname(this.historyFile), { recursive: true }); writeFileSync(this.historyFile, JSON.stringify({ history: this.registry.export(), pricing: this.pricing })); }
    catch (err) { console.warn(`[history] could not save: ${err.message}`); }
  }

  /** One finished job, real or simulated, goes on both agents' records and into the activity feed. */
  settle({ buyer, supplier, evaluator, amount, passed, sim }) {
    this.registry.record(supplier, { passed, amount, sim });
    this.registry.record(evaluator, { passed, amount, sim });
    this.activity.push({ ts: Date.now(), buyer, supplier, evaluator, amount, passed, sim });
    if (this.activity.length > 40) this.activity.shift();
    this.save();
  }

  /**
   * Simulated traffic from the other buyers, so the network keeps moving between your requests.
   * These jobs never touch PayPal and are always labelled as simulated. Paused while your request runs.
   */
  startAmbient(ms) {
    this.ambientOn = ms > 0;
    if (ms > 0) setInterval(() => this.ambientTick(), ms).unref();
  }
  setAmbient(on) { this.ambientOn = Boolean(on); this.changed(); }
  ambientTick() {
    if (!this.ambientOn || this.busy) return;
    const pick = (list) => list[Math.floor(Math.random() * list.length)];
    const s = pick(SUPPLIERS);
    this.settle({ buyer: pick(OTHER_BUYERS).id, supplier: s.id, evaluator: pick(EVALUATORS).id,
      amount: Math.round(120 + Math.random() * 1600), passed: Math.random() < s.reliability, sim: true });
    if (Math.random() < 0.3) { // now and then a supplier hires another one out of its own balance
      const partner = pick(SUPPLIERS.filter((x) => x.category !== s.category));
      const cost = Math.round(8 + Math.random() * 30);
      if (this.registry.balance(s.id) >= cost) {
        this.registry.spend(s.id, { kind: 'subcontract', amount: cost, to: partner.id, sim: true });
        this.registry.credit(partner.id, { kind: 'subcontract', amount: cost, from: s.id, sim: true });
        this.activity.push({ ts: Date.now() + 1, kind: 'sub', buyer: s.id, supplier: partner.id, amount: cost, sim: true });
      }
    }
    this.changed();
  }

  /**
   * Discovery. The four most trusted suppliers in the category are invited on merit. A fifth
   * invitation is a sponsored slot: it goes to the highest bidder among the rest, who pays for it
   * out of its own balance. The slot buys an invitation only. It never changes the ranking.
   */
  shortlist(category) {
    const trust = (s) => this.registry.stats(s.id).trust;
    const inCategory = SUPPLIERS.filter((s) => s.category === category).sort((a, b) => trust(b) - trust(a));
    if (inCategory.length < 2) {
      const rest = SUPPLIERS.filter((s) => !inCategory.includes(s)).sort((a, b) => trust(b) - trust(a));
      return { invited: [...inCategory, ...rest].slice(0, 4), merit: inCategory.map((s) => s.id), sponsored: null };
    }
    const merit = inCategory.slice(0, 4);
    const rest = inCategory.slice(4);
    const bidOf = (s) => this.registry.get(s.id).ad?.bid || 0;
    const bidder = rest.filter((s) => bidOf(s) > 0 && this.registry.balance(s.id) >= bidOf(s)).sort((a, b) => bidOf(b) - bidOf(a) || trust(b) - trust(a))[0];
    if (!bidder) return { invited: inCategory.slice(0, 5), merit: merit.map((s) => s.id), sponsored: null };
    return { invited: [...merit, bidder], merit: merit.map((s) => s.id), sponsored: { id: bidder.id, bid: bidOf(bidder) } };
  }

  /** Clears the current request only. Track records stay. */
  reset() {
    if (this.busy) throw new Error('A run is in progress.');
    this.ledger = new Ledger();
    this.run_ = null;
    this.busy = false;
    this.changed();
  }

  /** Wipes every track record back to the seeded starting point. */
  resetNetwork() {
    if (this.busy) throw new Error('A run is in progress.');
    this.buildRegistry();
    if (this.historyFile) rmSync(this.historyFile, { force: true });
    this.reset();
  }

  recordText(id) {
    const st = this.registry.stats(id);
    return `${st.passed} of ${st.jobs} past deliveries passed evaluation, trust score ${Math.round(st.trust * 100)} of 100`;
  }

  snapshot() {
    return {
      mode: { paypal: this.paypal.mode, llm: llmInfo, toolkit: toolsActive() },
      policy: { maxOrderUsd: this.maxOrderUsd, humanApprovalRequired: true },
      busy: this.busy,
      agents: this.registry.view().map((a) => ({ ...a, stance: this.pricing[a.id] || null })),
      economy: { evaluationFee: EVALUATION_FEE, buyerCommission: BUYER_COMMISSION },
      totals: this.registry.totals(),
      activity: this.activity.slice(-14),
      ambient: { on: Boolean(this.ambientOn) },
      run: this.run_ && { ...this.run_, jobs: this.run_.jobs.map((j) => j.view()) },
      ledger: this.ledger.entries,
      ledgerValid: this.ledger.verify(),
    };
  }

  changed() { this.onChange(this.snapshot()); }
  async step() { this.changed(); if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs)); }

  /** Called by the HTTP layer when PayPal redirects the human back. */
  resolveApproval(orderId, approved) {
    const waiter = this.pending.get(orderId);
    if (!waiter) return false;
    this.pending.delete(orderId);
    waiter.resolve(approved);
    return true;
  }

  waitForApproval(orderId) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.pending.delete(orderId); resolve(false); }, 15 * 60 * 1000);
      timer.unref?.();
      this.pending.set(orderId, { resolve: (v) => { clearTimeout(timer); resolve(v); } });
    });
  }

  async run(input) {
    if (this.busy) throw new Error('A run is already in progress.');
    this.reset();
    this.busy = true;
    const strategy = input.strategy === 'trust' ? 'trust' : 'price';
    const run = (this.run_ = { id: `RUN-${Date.now().toString(36).toUpperCase()}`, input, strategy, terms: null, jobs: [], outcome: null, error: null,
      before: Object.fromEntries(this.registry.ranking().map((r) => [r.id, { rank: r.rank, trust: r.trust }])) });
    try {
      // ---- REQUEST: the owner's sentence becomes checkable terms, and an RFQ goes to every provider.
      const terms = (run.terms = await parseRequest(input));
      const { invited, sponsored } = this.shortlist(terms.category);
      run.invited = invited.map((s) => s.id);
      run.sponsored = sponsored;
      if (sponsored) {
        const a = this.registry.get(sponsored.id);
        this.registry.spend(sponsored.id, { kind: 'ad', amount: sponsored.bid, sim: false });
        a.ad = a.ad.left > 1 ? { ...a.ad, left: a.ad.left - 1 } : null;
        this.activity.push({ ts: Date.now(), kind: 'ad', supplier: sponsored.id, amount: sponsored.bid, sim: false });
        this.ledger.append({ jobId: null, from: 'network', to: sponsored.id, type: 'SPONSORED_SLOT', phase: 'REQUEST',
          content: `${a.name} is in this request on a sponsored slot and paid ${usd(sponsored.bid)} from its own balance. A slot buys an invitation, not rank.`, source: 'system' });
        this.save();
      }
      const pairs = invited.map((s, i) => {
        const evaluator = EVALUATORS[this.evaluatorTurn++ % EVALUATORS.length].id;
        const job = new Job({ id: `${run.id}-J${i + 1}`, buyer: BUYER.id, provider: s.id, evaluator, ledger: this.ledger });
        run.jobs.push(job);
        return { s, job };
      });
      for (const { s, job } of pairs) {
        job.memo({ from: BUYER.id, to: s.id, type: 'REQUEST', content: rfqMessage(terms), data: { terms }, source: terms.source });
      }
      await this.step();

      // ---- NEGOTIATION: quote, one counter, final offer. Suppliers negotiate in parallel.
      await Promise.all(pairs.map(async (p) => {
        const quote = await supplierQuote(p.s, terms, this.recordText(p.s.id), this.pricing[p.s.id]?.adj);
        p.job.offer = { unitPrice: quote.unitPrice, leadDays: quote.leadDays };
        p.job.memo({ from: p.s.id, to: BUYER.id, type: 'QUOTE', content: quote.message, data: p.job.offer, source: quote.source, next: 'NEGOTIATION' });
        p.quote = quote;
      }));
      await this.step();
      await Promise.all(pairs.map(async (p) => {
        p.counter = await buyerCounter(terms, p.s, p.quote, this.recordText(p.s.id));
        p.job.memo({ from: BUYER.id, to: p.s.id, type: 'COUNTER', content: p.counter.message, data: { unitPrice: p.counter.unitPrice }, source: p.counter.source });
      }));
      await this.step();
      await Promise.all(pairs.map(async (p) => {
        const fin = await supplierFinal(p.s, terms, p.quote, p.counter);
        p.job.offer = { unitPrice: fin.unitPrice, leadDays: fin.leadDays };
        p.job.memo({ from: p.s.id, to: BUYER.id, type: 'FINAL_OFFER', content: fin.message, data: p.job.offer, source: fin.source });
      }));
      await this.step();

      // ---- Deterministic eligibility and ranking. No model decides who gets money.
      const eligible = [];
      for (const p of pairs) {
        const why = p.job.offer.unitPrice > terms.maxUnitPrice
          ? `Final offer ${usd(p.job.offer.unitPrice)} is above the ${usd(terms.maxUnitPrice)} per-unit ceiling.`
          : p.job.offer.leadDays > terms.deadlineDays
            ? `Lead time ${p.job.offer.leadDays} days misses the ${terms.deadlineDays}-day deadline.` : null;
        if (why) {
          p.job.note = why;
          p.job.memo({ from: BUYER.id, to: p.s.id, type: 'DECLINE', content: why, next: 'REJECTED' });
        } else eligible.push(p);
      }
      const trust = (p) => this.registry.stats(p.s.id).trust;
      const byPrice = (a, b) => a.job.offer.unitPrice - b.job.offer.unitPrice || a.job.offer.leadDays - b.job.offer.leadDays;
      const byTrust = (a, b) => trust(b) - trust(a) || byPrice(a, b);
      let queue = [...eligible].sort(strategy === 'trust' ? byTrust : byPrice);
      await this.step();

      // ---- TRANSACTION + EVALUATION. The owner picks who goes first (cheapest or most trusted).
      // After a rejected delivery the buyer agent stops chasing price and takes the most trusted supplier left.
      let paid = null;
      const voided = [];
      let reason = strategy === 'trust' ? 'Highest trust score among the offers that fit your limits.' : 'Lowest offer that fits your limits.';
      for (let tries = 0; queue.length && tries < 3; tries += 1) {
        const p = queue.shift();
        const result = await this.attempt(p, terms, queue, reason);
        if (result === 'PAID') { paid = p; break; }
        if (result === 'VOIDED') {
          voided.push(p);
          queue.sort(byTrust);
          reason = 'The previous delivery was rejected, so this is the most trusted supplier still available.';
        }
        if (result === 'STOP') break;
      }
      for (const p of eligible) {
        if (p.job.phase === 'NEGOTIATION') {
          p.job.note = paid ? 'Not needed: another supplier delivered and was paid.' : 'Not awarded.';
          p.job.memo({ from: BUYER.id, to: p.s.id, type: 'DECLINE', content: p.job.note, next: 'REJECTED' });
        }
      }
      // ---- Autonomy: every supplier agent in this category now decides, on its own, what to change
      // next time: its price, and whether to spend its own earnings on a sponsored slot.
      const peers = SUPPLIERS.filter((s) => s.category === terms.category);
      const meritNext = new Set(this.shortlist(terms.category).merit);
      await Promise.all(peers.map(async (s) => {
        const p = pairs.find((x) => x.s === s);
        const kind = !p ? 'not_invited' : p === paid ? 'paid' : voided.includes(p) ? 'rejected' : eligible.includes(p) ? 'outbid' : 'too_expensive';
        const r = await supplierReflect(s, { kind, offer: p?.job.offer.unitPrice ?? null, winner: paid?.job.offer.unitPrice ?? null,
          invitedOnMerit: meritNext.has(s.id), balance: this.registry.balance(s.id) }, this.recordText(s.id));
        const adj = Math.max(-0.12, Math.min(0.12, (this.pricing[s.id]?.adj || 0) + r.change));
        this.pricing[s.id] = { adj, note: r.note, source: r.source };
        this.registry.get(s.id).ad = r.adBid > 0 ? { bid: r.adBid, left: 2 } : null;
        this.ledger.append({ jobId: p?.job.id ?? null, from: s.id, to: 'network', type: 'OWN_DECISION', phase: p?.job.phase ?? '-', content: r.note, data: { change: r.change, adBid: r.adBid }, source: r.source });
      }));
      this.save();
      await this.step();

      run.outcome = {
        paid: paid && { supplier: paid.s.name, amount: paid.job.agreed.total, captureId: paid.job.escrow.captureId },
        voided: voided.map((p) => ({ supplier: p.s.name, amount: p.job.agreed.total })),
        summary: paid
          ? `${usd(paid.job.agreed.total)} released to ${paid.s.name} after verification.`
            + (voided.length ? ` ${voided.map((p) => `${usd(p.job.agreed.total)} held for ${p.s.name} was voided`).join('; ')} - that money never left the buyer.` : '')
          : 'No payment was released.' + (voided.length ? ' Every held amount was voided back to the buyer.' : ''),
      };
    } catch (err) {
      console.error(err);
      run.error = err.message;
    } finally {
      this.busy = false;
      this.changed();
    }
    return this.snapshot();
  }

  async attempt(p, terms, alternatives, reason) {
    const { s, job } = p;
    const total = money(job.offer.unitPrice * terms.quantity);

    // Guardrail 1: a spend limit set by a human, enforced in code before PayPal is ever called.
    if (total > this.maxOrderUsd) {
      job.note = `Blocked by policy: ${usd(total)} exceeds the ${usd(this.maxOrderUsd)} per-order limit.`;
      job.memo({ from: 'policy', to: BUYER.id, type: 'POLICY_BLOCK', content: job.note, next: 'REJECTED' });
      await this.step();
      return 'BLOCKED';
    }

    job.agreed = { item: terms.item, spec: terms.spec, quantity: terms.quantity, unitPrice: job.offer.unitPrice, leadDays: job.offer.leadDays, total, currency: 'USD' };
    const award = await buyerAwardNote(terms, s, job.offer, alternatives.map((a) => ({ supplier: a.s.name, unit_price: a.job.offer.unitPrice })), reason);
    job.memo({ from: BUYER.id, to: s.id, type: 'AWARD', content: award.message, data: job.agreed, source: award.source, next: 'TRANSACTION' });
    await this.step();

    // Guardrail 2: the human approves the hold in PayPal. Agents cannot move money without it.
    const order = await this.paypal.createEscrowOrder({
      jobId: job.id, amount: total, description: `${terms.quantity} x ${terms.item} (held until verified)`,
      returnUrl: `${this.baseUrl}/paypal/return`, cancelUrl: `${this.baseUrl}/paypal/cancel`, payeeEmail: this.payeeEmail,
    });
    job.escrow = { provider: this.paypal.mode, orderId: order.orderId, approveUrl: order.approveUrl, amount: total, status: 'AWAITING_BUYER_APPROVAL' };
    job.memo({ from: 'paypal', to: BUYER.id, type: 'ESCROW_REQUESTED', content: `PayPal order ${order.orderId} created for ${usd(total)} (intent AUTHORIZE). Waiting for the owner to approve the hold.`, data: { orderId: order.orderId } });
    this.changed();
    const approved = await this.waitForApproval(order.orderId);
    job.escrow.approveUrl = null;
    if (!approved) {
      job.escrow.status = 'NOT_APPROVED';
      job.note = 'The owner did not approve the hold. No money moved.';
      job.memo({ from: BUYER.id, to: s.id, type: 'CANCEL', content: job.note, next: 'REJECTED' });
      await this.step();
      return 'STOP';
    }
    const auth = await this.paypal.authorize(order.orderId);
    Object.assign(job.escrow, { status: 'AUTHORIZED', authorizationId: auth.authorizationId });
    job.memo({ from: 'paypal', to: s.id, type: 'ESCROW_FUNDED', content: `${usd(total)} is now held by PayPal (authorization ${auth.authorizationId}). It is not paid yet.`, data: { authorizationId: auth.authorizationId } });
    await this.step();

    // The supplier may spend its own money to hire another agent for part of the job.
    const partner = SUPPLIERS.filter((x) => x.category === (s.category === 'labels' ? 'packaging' : 'labels'))
      .sort((a, b) => this.registry.stats(b.id).trust - this.registry.stats(a.id).trust)[0];
    const cost = money(total * 0.02);
    const sub = await supplierSubcontract(s, { partner, cost, balance: this.registry.balance(s.id), total });
    if (sub.hire) {
      this.registry.spend(s.id, { kind: 'subcontract', amount: cost, to: partner.id, sim: false });
      this.registry.credit(partner.id, { kind: 'subcontract', amount: cost, from: s.id, sim: false });
      this.activity.push({ ts: Date.now(), kind: 'sub', buyer: s.id, supplier: partner.id, amount: cost, sim: false });
      job.subcontract = { partner: partner.id, cost };
      job.memo({ from: s.id, to: partner.id, type: 'SUBCONTRACT', content: sub.note, data: { cost }, source: sub.source });
      this.save();
      await this.step();
    }

    job.evidence = supplierDeliver(s, job);
    job.memo({ from: s.id, to: job.evaluator, type: 'DELIVERY', content: job.evidence.note, data: { packingList: job.evidence.packingList, labelSha256: job.evidence.labelSha256 }, next: 'EVALUATION' });
    await this.step();

    // The evaluator agent confirms on PayPal, through PayPal's Agent Toolkit, that the money is really held.
    const hold = await verifyHold({ evaluatorName: this.registry.get(job.evaluator).name, orderId: order.orderId, total });
    if (hold) {
      job.paypalCheck = hold;
      job.memo({ from: job.evaluator, to: 'paypal', type: 'TOOL_CHECK', content: `Checked order ${order.orderId} on PayPal with the Agent Toolkit get_order tool. ${hold.note}`,
        data: { toolkit: true, status: hold.status, amount: hold.amount }, source: hold.source });
      await this.step();
    }

    job.verdict = await evaluate(job, this.seenEvidence, hold);
    this.seenEvidence.add(job.evidence.labelSha256);
    job.memo({ from: job.evaluator, to: BUYER.id, type: job.verdict.approve ? 'VERDICT_APPROVE' : 'VERDICT_REJECT', content: job.verdict.reasoning, data: { checks: job.verdict.checks }, source: job.verdict.source });
    await this.step();

    // The evaluator is paid for the check itself, approve or reject.
    const fee = money(total * EVALUATION_FEE);
    let feeNote = `${usd(fee)} evaluation fee credited to ${this.registry.get(job.evaluator).name} on the network ledger.`;
    if (this.evaluatorPayeeEmail) {
      try {
        const po = await this.paypal.payout({ id: `fee-${job.id}`, email: this.evaluatorPayeeEmail, amount: fee, note: `Evaluation fee for ${job.id}` });
        feeNote = `${usd(fee)} evaluation fee sent to ${this.registry.get(job.evaluator).name} through PayPal Payouts (batch ${po.payoutId}, ${po.status}).`;
      } catch (err) { feeNote += ` PayPal payout failed: ${err.message}`; }
    }
    job.memo({ from: 'paypal', to: job.evaluator, type: 'FEE', content: feeNote, data: { fee } });

    if (job.verdict.approve) {
      const cap = await this.paypal.capture(auth.authorizationId, `Released after ACP evaluation of ${job.id}`);
      Object.assign(job.escrow, { status: 'CAPTURED', captureId: cap.captureId, captureStatus: cap.status });
      job.memo({ from: 'paypal', to: s.id, type: 'SETTLEMENT', content: `Captured ${usd(total)} (capture ${cap.captureId}, ${cap.status}). Supplier paid.`, data: { captureId: cap.captureId }, next: 'COMPLETED' });
      this.settle({ buyer: BUYER.id, supplier: s.id, evaluator: job.evaluator, amount: total, passed: true, sim: false });
      await this.step();
      // The paid supplier agent issues a PayPal invoice for the job through the Agent Toolkit.
      const inv = await invoiceForJob({ supplierName: s.name, payerEmail: auth.payerEmail || hold?.payerEmail, item: terms.item, quantity: terms.quantity,
        unitPrice: job.agreed.unitPrice, total, captureId: cap.captureId });
      if (inv?.ok) {
        job.invoice = inv;
        job.memo({ from: s.id, to: BUYER.id, type: 'INVOICE', content: `Issued PayPal invoice ${inv.invoiceId} with the Agent Toolkit${inv.recorded ? ' and marked it paid' : ''}. ${inv.note}`.trim(),
          data: { toolkit: true, invoiceId: inv.invoiceId }, source: 'llm' });
      } else if (inv) {
        job.memo({ from: s.id, to: BUYER.id, type: 'INVOICE', content: inv.note, data: { toolkit: true }, source: 'llm' });
      }
      // The buyer agent earns a share of what it saved its owner against the price limit.
      const saved = money((terms.maxUnitPrice - job.agreed.unitPrice) * terms.quantity);
      const commission = money(saved * BUYER_COMMISSION);
      if (commission > 0) {
        this.registry.record(BUYER.id, { passed: true, amount: commission, sim: false });
        job.memo({ from: 'network', to: BUYER.id, type: 'COMMISSION', content: `Your buyer agent saved you ${usd(saved)} against your price limit and keeps ${usd(commission)} as commission.`, data: { saved, commission } });
        this.save();
      }
      await this.step();
      return 'PAID';
    }
    await this.paypal.void(auth.authorizationId);
    job.escrow.status = 'VOIDED';
    job.note = 'Delivery rejected. Hold voided; the buyer was never charged.';
    job.memo({ from: 'paypal', to: BUYER.id, type: 'REFUND_VOID', content: `Authorization ${auth.authorizationId} voided. ${usd(total)} returned to the buyer; nothing was paid.`, next: 'REJECTED' });
    this.settle({ buyer: BUYER.id, supplier: s.id, evaluator: job.evaluator, amount: total, passed: false, sim: false });
    await this.step();
    return 'VOIDED';
  }
}
