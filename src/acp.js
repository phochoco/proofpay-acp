// A small Agent Commerce Protocol: registry + jobs with four phases + a hash-chained memo ledger.
// Modelled on the request -> negotiation -> transaction -> evaluation flow used by on-chain
// agent commerce networks, but settled on PayPal instead of a token.
import { createHash } from 'node:crypto';

export const PHASES = ['REQUEST', 'NEGOTIATION', 'TRANSACTION', 'EVALUATION'];
const ALLOWED = {
  REQUEST: ['NEGOTIATION', 'REJECTED'],
  NEGOTIATION: ['TRANSACTION', 'REJECTED'],
  TRANSACTION: ['EVALUATION', 'REJECTED'],
  EVALUATION: ['COMPLETED', 'REJECTED'],
};

export const sha256 = (s) => createHash('sha256').update(s).digest('hex');

/** Append-only log. Every memo commits to the previous one, so history cannot be edited quietly. */
export class Ledger {
  entries = [];
  append(entry) {
    const prevHash = this.entries.at(-1)?.hash ?? '0'.repeat(64);
    const body = { seq: this.entries.length + 1, ts: new Date().toISOString(), prevHash, ...entry };
    const record = { ...body, hash: sha256(JSON.stringify(body)) };
    this.entries.push(record);
    return record;
  }
  verify() {
    let prev = '0'.repeat(64);
    for (const { hash, ...body } of this.entries) {
      if (body.prevHash !== prev || sha256(JSON.stringify(body)) !== hash) return false;
      prev = hash;
    }
    return true;
  }
}

// How agents get paid. Evaluators earn on every job they check, whatever the verdict, so they have
// no reason to lean either way. The buyer agent earns a share of what it saves its owner.
export const EVALUATION_FEE = 0.015;
export const BUYER_COMMISSION = 0.10;

/**
 * Trust score: the lower bound of the 95% Wilson interval on an agent's pass rate.
 * A supplier with 3 passes out of 3 scores lower than one with 20 out of 20, because a thin
 * record proves less. One rejected delivery moves a thin record a lot and a long record a little.
 */
export function trustScore(passed, jobs) {
  if (!jobs) return 0;
  const z = 1.96, p = passed / jobs;
  return (p + (z * z) / (2 * jobs) - z * Math.sqrt((p * (1 - p) + (z * z) / (4 * jobs)) / jobs)) / (1 + (z * z) / jobs);
}

/** Who exists on the network, what they sell, and how every past job of theirs was evaluated. */
export class Registry {
  agents = new Map();
  register({ id, name, role, offering = '', category = '', seedHistory = [] }) {
    // `sim: true` marks history that did not go through this app's PayPal flow (seeded or background traffic).
    this.agents.set(id, { id, name, role, offering, category, spends: [], extra: [], ad: null, history: seedHistory.map((passed, i) => ({ passed, sim: true, amount: 240 + ((i * 197 + id.length * 53) % 1100) })) });
  }
  get(id) { return this.agents.get(id); }
  record(id, { passed, amount, sim = false }) {
    const h = this.agents.get(id).history;
    h.push({ passed, amount, sim });
    if (h.length > 60) h.splice(0, h.length - 60); // rolling window: old jobs stop counting
  }
  /** Money an agent pays out of its own balance: a sponsored slot, or another agent it hires. */
  spend(id, entry) {
    const list = this.agents.get(id).spends;
    list.push(entry);
    if (list.length > 60) list.splice(0, list.length - 60);
  }
  /** Money an agent receives outside its own deliveries, such as subcontract work. */
  credit(id, entry) {
    const list = this.agents.get(id).extra;
    list.push(entry);
    if (list.length > 60) list.splice(0, list.length - 60);
  }
  spent(id) { return this.agents.get(id).spends.reduce((n, e) => n + e.amount, 0); }
  balance(id) { return this.earned(id) - this.spent(id); }
  adRevenue() { return [...this.agents.values()].reduce((n, a) => n + a.spends.filter((e) => e.kind === 'ad').reduce((m, e) => m + e.amount, 0), 0); }

  stats(id) {
    const h = this.agents.get(id).history;
    let passed = 0;
    const series = h.map((e, i) => { if (e.passed) passed += 1; return trustScore(passed, i + 1); });
    const live = h.filter((e) => !e.sim);
    return {
      jobs: h.length, passed, trust: trustScore(passed, h.length), series,
      earned: this.earned(id), spent: this.spent(id), balance: this.balance(id),
      liveJobs: live.length,
      settled: live.filter((e) => e.passed).reduce((sum, e) => sum + e.amount, 0),
      returned: live.filter((e) => !e.passed).reduce((sum, e) => sum + e.amount, 0),
    };
  }
  /** Suppliers earn the sale when a delivery passes; evaluators earn a fee per check; buyer agents earn commission. */
  earned(id) {
    const a = this.agents.get(id);
    const sum = (list) => list.reduce((n, e) => n + (e.amount || 0), 0);
    if (a.role === 'provider') return sum(a.history.filter((e) => e.passed)) + sum(a.extra);
    if (a.role === 'evaluator') return sum(a.history) * EVALUATION_FEE;
    return sum(a.history);
  }
  /** Providers ranked by trust; longer records win ties. */
  ranking() {
    return [...this.agents.values()].filter((a) => a.role === 'provider')
      .map((a) => ({ id: a.id, ...this.stats(a.id) }))
      .sort((a, b) => b.trust - a.trust || b.jobs - a.jobs)
      .map((a, i) => ({ ...a, rank: i + 1 }));
  }
  view() {
    const ranks = new Map(this.ranking().map((r) => [r.id, r]));
    return [...this.agents.values()].map((a) => ({ ...a, ...(ranks.get(a.id) || this.stats(a.id)) }));
  }
  totals() {
    const r = this.ranking();
    const sum = (k) => r.reduce((n, a) => n + a[k], 0);
    return { checked: sum('liveJobs'), settled: sum('settled'), returned: sum('returned'), recorded: sum('jobs'), adRevenue: this.adRevenue() };
  }
  export() { return Object.fromEntries([...this.agents.values()].map((a) => [a.id, { history: a.history, spends: a.spends, extra: a.extra, ad: a.ad }])); }
  import(data) {
    for (const [id, saved] of Object.entries(data || {})) {
      const a = this.agents.get(id);
      if (!a || !Array.isArray(saved?.history)) continue;
      Object.assign(a, { history: saved.history, spends: saved.spends || [], extra: saved.extra || [], ad: saved.ad || null });
    }
  }
}

/** One buyer <-> provider engagement. Phase changes are only possible through a memo. */
export class Job {
  constructor({ id, buyer, provider, evaluator, ledger }) {
    Object.assign(this, { id, buyer, provider, evaluator });
    this.ledger = ledger;
    this.phase = 'REQUEST';
    this.note = '';
    this.offer = null;     // latest price/lead time on the table
    this.agreed = null;    // terms locked in at award
    this.escrow = null;    // PayPal order / authorization / capture state
    this.evidence = null;  // what the provider delivered
    this.verdict = null;   // evaluator result
  }
  memo({ from, to, type, content, data, source = 'system', next }) {
    if (next) {
      if (!ALLOWED[this.phase]?.includes(next)) {
        throw new Error(`ACP: illegal transition ${this.phase} -> ${next} on ${this.id}`);
      }
      this.phase = next;
    }
    return this.ledger.append({ jobId: this.id, from, to, type, phase: this.phase, content, data, source });
  }
  view() {
    const { ledger, ...rest } = this;
    return rest;
  }
}
