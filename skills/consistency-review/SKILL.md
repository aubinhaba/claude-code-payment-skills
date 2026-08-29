---
name: consistency-review
description: Reviews distributed-consistency correctness in event-driven and integration code. Checks transactional outbox usage, idempotency keys, duplicate and out-of-order callbacks, timeout handling on non-idempotent remote calls, retry and DLQ policy, compensation and reconciliation. Use when reviewing a queue consumer or producer, a webhook or callback handler, a saga or multi-step workflow, a retry policy, or any code that writes to a database and calls a remote service in the same operation; when the diff touches SQS, Kafka or RabbitMQ, an outbox table or relay, @Transactional methods that also perform network calls, retry and backoff configuration, dead-letter handling or a reconciliation job; or when asked whether something is safe to retry, or what happens if it is delivered twice.
allowed-tools: Read, Grep, Glob, Bash(git diff:*), Bash(git log:*), Bash(git show:*)
license: MIT
---

# Distributed consistency review

Two writes, one of them remote, and no transaction spanning both. Every defect in this
review comes from that shape. The reviewer's job is to find the interleaving the author
did not consider, and to name it concretely — "the callback arrives before the
authorization response is committed" — rather than to recommend a pattern.

Work through the five checks in order. Stop at the first BLOCKER only if it invalidates
the design; otherwise report everything.

## 1. Dual write

Find every place the change writes to the database **and** publishes a message, sends a
webhook, or calls a remote API.

- If both happen in one method, ask what the system looks like when the first succeeds
  and the second does not. Then ask the same with the order reversed. One of the two
  answers is usually "we lost the event" or "we announced something that did not happen".
- The fix in almost every case is the **transactional outbox**: the state change and the
  outbox row are written in the same database transaction, and a separate relay
  publishes. Verify:
  - the outbox insert is genuinely inside the same transaction (not in a
    `@TransactionalEventListener(AFTER_COMMIT)` that opens a new one, not in an
    `afterCommit` callback that can fail silently);
  - the relay is at-least-once and says so, which makes **every consumer's idempotency
    mandatory, not optional**;
  - failed rows have an attempt counter and a terminal state, so a poison row does not
    block the queue or spin forever;
  - ordering, if the domain needs it, is preserved by a partition/group key — an outbox
    with parallel relay workers does not preserve global order.
- Kafka transactions or `@Transactional` around a `KafkaTemplate.send` do not solve the
  dual write against a relational database. Say so if the diff relies on it.

Check the reverse shape too: a remote call **inside** a database transaction. It holds a
connection for the duration of someone else's latency, and a timeout leaves the
transaction to roll back while the remote side has already acted. Remote calls belong
outside the transaction boundary, with the result recorded by a second, short
transaction.

## 2. Idempotency

Every consumer of an at-least-once channel, and every endpoint a client may retry, must
be idempotent. "The code is naturally idempotent" is a claim to verify, not accept.

- **Key**: what identifies the operation? A client-supplied idempotency key, the PSP
  event id, the message id? It must be scoped (`merchant_id` + key) so two merchants
  cannot collide, and stored.
- **Enforcement**: a unique index, so the second attempt fails at the database rather
  than passing an application-level `existsBy` check that two concurrent workers both
  pass. `INSERT ... ON CONFLICT DO NOTHING` and "did I insert a row?" is the cheapest
  correct implementation.
- **Concurrent duplicate**: two deliveries processed at the same moment. The loser must
  either wait for the winner's result or return a "in progress" response — not proceed.
- **Replay of the response**: a retried request with the same key and the same body
  should return the original response, not a fresh one. A retried key with a *different*
  body is a client bug and must be rejected (409), not silently served.
- **Scope of the effect**: idempotency that protects the database row but not the email,
  the webhook, or the ledger entry is partial. Enumerate the side effects and check each.
- **Expiry**: keys stored forever grow without bound; keys expired after an hour break a
  client retrying after an outage. State the window.

## 3. Ordering, duplication and lateness

For every inbound event or callback:

- **Duplicates.** Assume every message is delivered more than once. See check 2.
- **Out of order.** `captured` can arrive before `authorized`. Do not sequence by arrival.
  Either drive a state machine that refuses backward transitions, or compare a
  monotonic field from the source (event sequence, `created_at` from the provider) and
  discard the stale one. Record the discard; silent drops make incidents unexplainable.
- **Arrives before its cause.** The PSP callback can reach you before the HTTP response
  to your authorization request has been committed locally. Handle the unknown reference:
  park the event and retry, or upsert a placeholder. Returning 404 to the PSP and hoping
  their retry is late enough is a race with a scheduler you do not own.
- **Authenticity.** A callback endpoint is a public write path. Signature verified
  before parsing, constant-time comparison, timestamp freshness window, replay window
  enforced. An unauthenticated callback that moves a payment to `PAID` is a BLOCKER.

## 4. Timeouts on non-idempotent remote calls

The most expensive bug in payments: **a timeout treated as a failure.**

When an authorization request times out, the state is *unknown*, not *declined*. The PSP
may have authorized. Retrying without an idempotency key charges twice; failing the
order releases the inventory on a card that was actually charged.

Review:

- Every remote call has a **connect and a read timeout**, set explicitly. A missing read
  timeout is a BLOCKER on any call in a request path.
- **Retries** exist only where the operation is idempotent, or where an idempotency key
  is sent with the retry. Retrying a POST that creates a charge without such a key is a
  BLOCKER.
- Backoff is **exponential with jitter**. Fixed-interval retries from every instance
  reconverge into the synchronised burst that keeps the dependency down.
- The **unknown** outcome is modelled explicitly: a state such as `PENDING_UNKNOWN`, a
  scheduled query of the provider's status endpoint, and a bound on how long it may
  remain unknown before a human is involved.
- A **circuit breaker** where a dependency's failure would otherwise exhaust the thread
  pool or connection pool. Check its fallback is a defined behaviour, not an exception
  wearing a different name.

## 5. Failure handling — retry, DLQ, reconciliation

- **Retry budget**: how many attempts, over what total duration, and what happens after.
  "Infinite retry" is a queue that never drains and an alert nobody can clear.
- **DLQ**: does one exist, is it monitored with an alert on depth > 0, and is there a
  documented way to replay a message after a fix? A DLQ nobody reads is a delete with
  extra steps.
- **Poison messages**: a permanently unprocessable payload must reach the DLQ quickly,
  not consume the retry budget of the whole queue.
- **Compensation**: for a multi-step operation, what undoes step 2 when step 3 fails
  permanently? If the answer is "nothing, we log it", that has to be an explicit
  decision with a reconciliation job behind it, not an omission.
- **Reconciliation**: for any state shared with an external system, there must be a
  periodic comparison — our terminal states against theirs — and a report of the
  differences. Without it, the system's correctness depends on no message ever being
  lost, which is not a property any queue offers.

## Failure-scenario table

Produce this table for the reviewed change. It is the deliverable that makes the review
useful to the author, and it is the artefact worth pasting into the PR.

| # | Failure | Expected behaviour | Mechanism | Present? |
| :-- | :--- | :--- | :--- | :--- |
| S1 | Message delivered twice | Second is a no-op, same response | Unique index on `(merchant_id, event_id)` | yes |
| S2 | Authorization call times out | State `PENDING_UNKNOWN`, status polled | Timeout + status query job | **no — BLOCKER** |
| S3 | Callback arrives before local commit | Event parked, retried | Placeholder upsert | partial |
| S4 | Relay crashes after publish, before mark | Duplicate publish, consumer absorbs | At-least-once + S1 | yes |

See `references/failure-modes.md` for the full catalogue to draw from, and for the
mechanism that answers each one.

## Output format

```
VERDICT: REQUEST CHANGES | APPROVE WITH FOLLOW-UPS | APPROVE

BLOCKER  OrderService.java:88  Charge retried without an idempotency key
  Interleaving: PSP receives the first POST, responds after our 2s read timeout,
  the retry creates a second charge. Customer is debited twice.
  Fix: send the same Idempotency-Key header on every attempt of one logical charge.

[failure-scenario table]

NOT REVIEWED: <files or paths you did not read>
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

Every finding names the interleaving. A finding that cannot be expressed as a sequence
of events is an opinion, and belongs in a different review.
