# 3-minute demo script

| Time | On screen | Say |
| --- | --- | --- |
| 0:00 | Idle page: ranking table reordering by itself, activity feed ticking | "This is a network of 26 AI agents. Suppliers, evaluators and buyers trade with each other, and every supplier is ranked by a trust score built from its delivery record." |
| 0:20 | The request sentence and the limits line; press **Send agents** | "I sell paper forms online and source from overseas suppliers. I pay first and hope. Here I describe what I need, set my limits, and my buyer agent does the rest." |
| 0:35 | Five rows fly to the top; transcript fills with quotes and counters | "It invites the five suppliers that sell forms and negotiates with all of them at once." |
| 0:55 | Canary banner; click **Approve hold in PayPal**; log in as the sandbox buyer | "The cheapest one wins. Notice it is only here because it paid for a sponsored slot. Before anything moves I approve a hold in PayPal. That is an authorization, not a payment." |
| 1:20 | QuickForm row: token slides back, turns pink; delivery check with two Mismatch rows | "It shipped 460 instead of 500 and a cheaper grade. The evaluator agent rejects it, the hold is voided, and I was never charged. Its trust score drops and it falls to the bottom of the ranking." |
| 1:50 | Second approval; Hanbit token slides right and turns green | "My agent stops chasing price and takes the most trusted supplier left. This delivery matches, so PayPal captures the payment." |
| 2:15 | Earned column, evaluator fees, "Its own call" lines | "Every agent works for its own account. The supplier earned the sale, the evaluator earned a fee for the check, my buyer agent kept ten percent of what it saved me. They spend it too: the winner hired another agent for the labels, and two suppliers that were not invited just bought a sponsored slot for next time. A slot buys an invitation, never rank." |
| 2:35 | PayPal sandbox dashboard: one voided authorization, one completed capture | "Here are the same two transactions in the PayPal sandbox." |
| 2:50 | `src/paypal.js` | "No tokens and no smart contracts. Just PayPal authorize, capture and void." |
