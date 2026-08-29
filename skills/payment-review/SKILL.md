---
name: payment-review
description: Reviews code that moves money or touches card data. Checks PCI DSS scope, tokenization boundaries, PAN/CVV leakage into logs and traces, 3-D Secure flows, amount and currency arithmetic, refund and capture invariants, and the audit trail. Use when reviewing a payment, billing, checkout, tokenization, wallet, refund, dispute, chargeback, payout or PSP-adapter change; when the diff contains card fields, amounts, currencies or payment state transitions; when a review mentions PCI, PAN, CVV, 3DS, capture, authorization or settlement; or before merging a change that alters how money is computed, stored or reported.
allowed-tools: Read, Grep, Glob, Bash(git diff:*), Bash(git log:*), Bash(git show:*)
license: MIT
---

# Payment review

A payment change is not reviewed like ordinary code. Two failure classes dominate,
and neither shows up in a green test suite: **the change quietly enlarges PCI scope**,
and **the change breaks a money invariant that only surfaces at reconciliation time**.
Review for those first. Everything else is ordinary code review.

## Scope of the review

Read the diff, then the surrounding code the diff depends on. Never review the diff
alone: a leak is usually the meeting point between new code and old code (a new field
added to an object that an existing logger serialises wholesale).

If the change is under 200 lines, review all of it. If it is larger, review in this
order and say so: card-data paths → money arithmetic → state transitions → the rest.

## 1. PCI scope — does this change widen the CDE?

The single question that matters: **after this change, does a component handle
cardholder data that did not handle it before?** Every "yes" is a BLOCKER unless the
change explicitly documents the scope decision.

Check, in the diff and in what it calls:

- **PAN / CVV entering a new process.** A new service, Lambda, batch, queue message,
  cache entry, analytics event or third-party SDK that receives a raw PAN pulls that
  component into the CDE and into the next audit.
- **The tokenization boundary.** Raw card data must stop at the component that
  exchanges it for a token. Anything downstream must speak tokens only. Flag any
  method that accepts both a token and a raw PAN "for convenience".
- **Card capture isolation.** A hosted field / iframe must (a) be served from an
  origin dedicated to card entry, (b) validate `event.origin` on every `postMessage`
  handler against an allowlist — never `'*'`, never a `startsWith` check, (c) never
  post the PAN to the parent frame, only the token or a display mask.
- **CVV storage.** CVV/CVC must never be persisted — not encrypted, not "temporarily",
  not in a retry payload, not in an outbox row, not in a request body kept for debug.
  If the code stores a request payload for replay, verify the CVV is stripped *before*
  persistence, not after.
- **Storage of PAN.** If a PAN is stored at all, check it is encrypted, that the key
  is not in the repository or in the same store as the data, and that a retention
  window exists and is enforced by a job, not by intention.

See `references/pci-scope.md` for the questions to ask per component type and the
common "it's only for support" traps.

## 2. Leakage — the PAN is in the logs

Grep the diff and the classes it touches for the paths a card number actually escapes.
The habitual offenders, in the order they bite:

| Path | What to look for |
| :--- | :--- |
| Structured logs | `log.info("... {}", request)`, `toString()` on a DTO holding card fields, Lombok `@Data`/`@ToString` on a card object |
| Exceptions | Validation messages echoing the invalid value; `IllegalArgumentException("bad card " + pan)`; stack traces from a JSON parser that includes the fragment being parsed |
| Traces / metrics | PAN or token used as a span attribute, metric tag, or cache key that reaches an exporter |
| HTTP | Card data in a query string or path segment (it lands in access logs, proxies, referrers); `Location` redirects carrying the PAN |
| Persistence | Debug tables, request archives, `payload` JSONB columns, dead-letter records |
| Test fixtures | A real PAN pasted into a fixture, a `.http` file, or a snapshot |

Verify masking is applied by the serialiser, not by call sites. Masking that depends
on every developer remembering to call `mask()` is not masking. A converter registered
on the ObjectMapper / logging encoder is; check the new fields are covered by it.

Also check what the PAN mask actually reveals: first six + last four is the maximum,
and only where the business needs it. Full first-six on a low-cardinality issuer plus
last four plus expiry plus cardholder name is not anonymous.

## 3. Money arithmetic

- **No `float`/`double` for amounts. Ever.** `BigDecimal` or integer minor units.
- **Amount and currency travel together.** A bare `long amount` in a method signature
  is a defect waiting for the first multi-currency merchant. Prefer a `Money` value
  object; if the codebase has one, flag any signature that decomposes it.
- **No arithmetic between different currencies**, and no implicit conversion. If a
  conversion happens, the rate and its timestamp are part of the record.
- **Rounding is declared, not inherited.** `BigDecimal` division without an explicit
  `RoundingMode` throws or, worse, is "fixed" by someone adding `ROUND_HALF_UP`
  without checking the scheme rules. Split payments, instalments and fee computation
  each need a stated rounding rule and a residual-allocation rule.
- **Comparison**: `BigDecimal.equals` compares scale too — `10.0 != 10.00`. Use
  `compareTo`. This is a real bug in refund-equality checks.

See `references/money.md` for the invariants a review should assert.

## 4. State and invariants

Payment state is a directed graph with terminal states. Review the transition, not the
field assignment.

- Can the code move a payment **backwards** out of a terminal state
  (`CAPTURED → PENDING`)? Terminal must be terminal, enforced in the domain and by a
  database constraint or a guarded `UPDATE ... WHERE status = ?`.
- **Refund total ≤ captured total**, checked under a lock or by a constraint, not by a
  read-then-write that two concurrent refunds both pass.
- **Capture ≤ authorized**, and authorization expiry is respected.
- Is the transition **idempotent** on retry? A payment change that is not safe to
  replay is a payment change that will double-charge. If the diff touches callbacks,
  retries or queue consumers, run `consistency-review` as well — that is where those
  live.
- Every state change writes an **audit record**: who/what caused it, when, the source
  event id, the previous and the new state. "The row was updated" is not an audit
  trail; disputes are won with audit trails.

## 5. Authorization of the operation

Payment endpoints are the highest-value target in the system.

- Is the caller allowed to act **on this specific payment**, not merely authenticated?
  Check the object-level check exists (merchant/tenant id from the token, compared to
  the resource) and is not derived from a request parameter the client controls.
- Refund, void and payout endpoints need a stricter check than read endpoints. Flag any
  that share one `@PreAuthorize` with a read.
- Webhook endpoints must verify the PSP signature **before** parsing the body, compare
  with a constant-time function, and reject stale timestamps.
- Amounts and currencies must come from the server-side record, never from the client
  request, at capture and refund time.

## Output format

Report findings in severity order. Nothing else.

```
VERDICT: REQUEST CHANGES | APPROVE WITH FOLLOW-UPS | APPROVE

BLOCKER  path/File.java:120  PAN reaches the analytics event
  Why it matters: pulls the analytics consumer into PCI scope; audit finding.
  Fix: publish the token and the masked display value; drop the raw field.

MAJOR    path/Refund.java:44  Refund total checked with read-then-write
  Failure: two concurrent refunds of 50 on a 60 capture both pass the check.
  Fix: unique/partial constraint or SELECT ... FOR UPDATE on the payment row.

MINOR    ...
NOTE     ...
```

Severity, so that two skills reviewing one diff produce comparable verdicts:

| Level | Threshold |
| :--- | :--- |
| **BLOCKER** | Merging this loses money or data, or produces an audit finding. |
| **MAJOR** | A defect that will surface in production under load or partial failure. |
| **MINOR** | A maintenance cost, or a defect bounded to a single caller. |
| **NOTE** | Something the author should know. No action required. |

One BLOCKER is enough for REQUEST CHANGES. MAJOR findings alone are
APPROVE WITH FOLLOW-UPS only when each one has an owner and a date.

Rules for the report:

- **No finding without a concrete failure scenario.** "Consider using a Money object"
  is noise. "A EUR refund against a USD capture passes this check" is a finding.
- **Cite file and line.** A finding that cannot be located cannot be fixed.
- If a check does not apply, do not list it as passed. A wall of green ticks hides the
  one red line.
- State explicitly what you did **not** review (files not read, generated code skipped).

## What this skill deliberately does not do

It does not run a generic OWASP pass, lint style, or comment on naming. Other tools do
that better, and mixing them dilutes the findings that matter. It reviews money and
card data.
