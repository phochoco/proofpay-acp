# ProofPay ACP

**Agent-to-agent procurement where PayPal only pays after the delivery is verified.**

**Live demo:** <https://proofpay-acp.onrender.com> (PayPal sandbox, Claude agents). The free instance
sleeps when idle, so the first visit can take up to a minute.

Small online sellers who source from overseas suppliers usually pay first and find out later. If the
carton arrives short, or with a cheaper grade than agreed, the money is already gone.

ProofPay ACP puts an agent commerce protocol on top of PayPal:

1. A **buyer agent** turns the owner's plain-language request into checkable terms and sends an RFQ.
2. **Supplier agents** quote, the buyer agent counters, and they settle on a final offer.
3. The buyer's money is **held on PayPal** (Orders v2, `intent: AUTHORIZE`) after the owner approves it.
4. An independent **evaluator agent** compares the delivery evidence with the agreed terms.
5. Approved: the authorization is **captured** and the supplier is paid.
   Rejected: the authorization is **voided**, the buyer is never charged, and the next supplier is tried.

Crypto agent networks do this with tokens and smart contracts. This does it with a PayPal account.

## The network

26 agents share one registry: 16 supplier agents across five categories, 3 evaluator agents, your
buyer agent and 6 other buyers. Every supplier has a public track record and a **trust score**, and
the page ranks them live.

- **Trust score** is the lower bound of the 95% Wilson interval on an agent's pass rate. A spotless
  record of 3 jobs scores 44; a spotless record of 20 scores 84. One rejected delivery costs a thin
  record far more than a long one.
- **Discovery:** the buyer agent classifies the request. The four most trusted suppliers in that
  category are invited on merit. A fifth invitation is a **sponsored slot** (see below).
- **Who goes first** is the owner's choice: the cheapest offer, or the most trusted supplier. After a
  rejected delivery the buyer agent stops chasing price and takes the most trusted supplier left.
- Track records are saved to `data/network.json`, so rankings carry over from one request to the next.

## Agents work for their own account

This is what separates it from a checkout page: every agent earns, and every agent makes its own calls.

| Agent | How it earns | What it decides on its own |
| --- | --- | --- |
| Supplier | The sale, once its delivery passes | Its quote and final offer, and after every request how to move its price next time (shown as "Its own call") |
| Evaluator | 1.5% of every job it checks, approve or reject, so it has no stake in the verdict | Whether the held money is released |
| Buyer | 10% of what it saves its owner against the price limit | Who to invite, how hard to counter, who to award |

### Agents spend what they earn

- **Sponsored slots.** The fifth invitation to each request is sold to the highest bidder among the
  suppliers that did not make the top four, and paid from that agent's own balance. A slot buys an
  invitation and nothing else: it never moves the ranking, and the delivery still has to pass. After
  every request each supplier decides for itself whether to bid.
- **Subcontracting.** A supplier holding an order can hire another agent for part of it (here, the
  carton labels) and pay from its own balance. It stays responsible for the whole delivery.

In the default run QuickForm Trading is there because it bought a slot. It wins on price, fails the
check, earns nothing and stops advertising. Ads bought it visibility; the escrow made sure they did
not buy it the buyer's money.

The supplier's payment is a PayPal capture. Slot fees and subcontract payments are recorded on the
network ledger. The evaluator's fee is credited on the network ledger, or
sent through **PayPal Payouts** when `EVALUATOR_PAYEE_EMAIL` is set. The buyer agent's commission is
recorded on the network ledger.

## The demo in one run

The default request (500 NCR receipt books, max $2.00 each, cheapest first) plays out like this:

| Supplier | Final offer | What happens |
| --- | --- | --- |
| QuickForm Trading | $1.51 | In on a sponsored slot. Cheapest, with a thin 3-job record. Ships 460 instead of 500, and 2-part instead of 3-part. Evaluator rejects. **$755.00 hold voided.** Trust falls from 44 to 30. |
| Hanbit Paper Co. | $1.84 | Most trusted supplier left. Hires StickyPress for the carton labels out of its own balance, ships exactly as agreed. Evaluator approves. **$920.00 captured.** |
| Moa Print, Seorim Forms | $1.77, $1.75 | Not needed. Each lowers its own opening price for next time. |
| Jeil Forms, Namsan Trading | not invited | Each decides to buy a sponsored slot for the next request. |
| Daeyang Print Works | $2.23 | Above the price limit. Declined during negotiation. |

Run it again with "most trusted" selected and the buyer agent goes straight to Hanbit, whose price has
moved because it decided to raise it after winning.

## Two views

- **Your order** walks the owner through one purchase in five steps: tell the agent what to buy,
  agents negotiate, approve a hold in PayPal, the delivery is checked, the supplier is paid (or the
  hold is released). The one action the owner has to take is always shown in a single place.
- **Agent network** shows the market behind it: every supplier ranked by trust, what each agent has
  earned and spent, sponsored slots, subcontracts and a live activity feed.

## Verified in the PayPal sandbox

A run on the live demo produced these sandbox transactions:

| Supplier | PayPal order | Authorization | Result |
| --- | --- | --- | --- |
| QuickForm Trading ($695.00) | `9WJ30965L0345654F` | `815684354E9973020` | Delivery failed the check, authorization **voided** |
| Hanbit Paper Co. ($875.00) | `8HY60512M8550322A` | `6H022418P1269690K` | Delivery passed, **captured** as `91S05700L20398739` |

## How PayPal is used

All calls are in [`src/paypal.js`](src/paypal.js), against `https://api-m.sandbox.paypal.com`:

| Protocol step | PayPal call |
| --- | --- |
| Open escrow | `POST /v2/checkout/orders` with `intent: AUTHORIZE` |
| Owner approves the hold | PayPal approval page (`payer-action` link), then redirect to `/paypal/return` |
| Funds held | `POST /v2/checkout/orders/{id}/authorize` |
| Evaluator approves | `POST /v2/payments/authorizations/{id}/capture` |
| Evaluator's fee (optional) | `POST /v1/payments/payouts` |
| Evaluator rejects | `POST /v2/payments/authorizations/{id}/void` |

Every write carries a `PayPal-Request-Id`, so a retry can never double-charge.

## How AI is used

Language models talk, negotiate and explain. Plain code enforces every number that touches money.

| Agent | The model does | Code enforces |
| --- | --- | --- |
| Buyer | Extracts a checkable spec and category from free text, writes counter-offers, explains the award to the owner | Price ceiling, deadline, deterministic ranking |
| Supplier (x16) | Negotiates in its own persona with a private cost floor, then decides how to reprice, whether to advertise and whether to subcontract | Never below its floor, never above its own quote, price moves capped |
| Evaluator | Reads the packing list and the supplier's free-text note, can veto the payout | Field-by-field checks; the model can never approve past a failed check |

Set `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` to turn the models on. Every memo in the ledger is
labelled `AI-written`, `scripted` or `system`, so the UI never claims more than what happened.

## Guardrails

- **Spend limit** (`MAX_ORDER_USD`): checked in code before PayPal is called. Agents cannot raise it.
- **Human approval**: a hold only exists after the owner approves it in PayPal.
- **Two-layer evaluation**: hard checks and a model veto; either one blocks the payout.
- **Hash-chained ledger**: each memo commits to the previous one, so the history is tamper-evident.
- **Legal phase transitions only**: a job cannot jump from negotiation to settlement.

## Run it

Requires Node.js 20 or newer. There are no dependencies to install.

```bash
cp .env.example .env    # then fill in the values below
npm start               # http://localhost:3000
```

1. Create a free account at <https://developer.paypal.com>, open **Apps & Credentials > Sandbox**,
   and copy the default app's **Client ID** and **Secret** into `.env`.
2. Add one AI key (`ANTHROPIC_API_KEY` or `OPENAI_API_KEY`) and, if needed, the model name.
3. Open the app, press **Send agents**, and when asked, approve the hold by logging in with your
   **sandbox personal (buyer) account** from **Testing Tools > Sandbox Accounts**.

With an empty `.env` the app still runs: PayPal is replaced by a clearly labelled mock and the agents
are scripted. `npm run demo` runs that offline flow in the terminal as a smoke test.

## What is real and what is simulated

- **Real:** the protocol, the ledger, the guardrails, the evaluator logic, and (with credentials) every
  PayPal sandbox call and every model call.
- **Simulated:** the suppliers are virtual agents, and "shipping" is a packing list plus a generated
  carton label. Some suppliers are programmed to under-deliver or ship late so the rejection path can be shown.
- **Simulated background traffic:** jobs between the *other* buyers and the suppliers are generated
  locally so the rankings keep moving. They never touch PayPal, are labelled "Simulated" in the activity
  feed, and are drawn as faded marks in every track record. Turn them off in the UI or with `AMBIENT_MS=0`.
  Each agent starts with a seeded history, also drawn faded.
- **Settlement account:** by default captured funds settle to the sandbox merchant that owns the API
  credentials. Set `SUPPLIER_PAYEE_EMAIL` to a sandbox business account to pay a separate supplier.
- The current request is kept in memory. Track records and pricing stances are saved to `data/network.json`.

## Project layout

```
src/acp.js           protocol: registry, trust score, earnings, job phases, hash-chained ledger
src/agents.js        the agent roster and the buyer, supplier and evaluator behaviour
src/llm.js           Anthropic / OpenAI JSON helper with scripted fallback
src/paypal.js        PayPal Orders v2 escrow client (+ mock)
src/orchestrator.js  discovery, the four phases, settlement, fees, background traffic
src/server.js        HTTP server, live updates, PayPal return handling
public/index.html    single-page UI
public/fonts/        Archivo variable font (SIL Open Font License, see OFL.txt)
scripts/demo.js      headless offline run
```

## What comes next

- Photo evidence checked by a vision model, including detection of reused or AI-generated product photos.
- Real supplier agents reachable over an open protocol instead of in-process personas.
- Partial capture for partial deliveries, and PayPal Payouts for multi-party splits.

## License

MIT. The bundled Archivo font is licensed separately under the SIL Open Font License 1.1.
