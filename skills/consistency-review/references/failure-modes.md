# Failure-mode catalogue

Draw from this list when building the failure-scenario table for a change. Not every
scenario applies to every diff; the ones that apply and are unhandled are the findings.

Each entry: the failure, the behaviour a reviewer should expect, and the mechanism that
produces it.

## Messaging

| # | Failure | Expected behaviour | Mechanism |
| :-- | :--- | :--- | :--- |
| M1 | Message delivered twice | Second delivery is a no-op returning the same outcome | Idempotency key + unique index |
| M2 | Messages delivered out of order | Stale event discarded and recorded | Monotonic source sequence, or a forward-only state machine |
| M3 | Message lost between commit and publish | Event eventually published | Transactional outbox + relay |
| M4 | Consumer crashes mid-processing | Message redelivered, no partial effect visible | Ack after effects; effects idempotent or in one transaction |
| M5 | Poison message | Fast path to DLQ, queue keeps draining | Max receive count, redrive policy |
| M6 | DLQ fills | Alert fires, replay procedure exists | Alarm on `ApproximateNumberOfMessagesVisible` on the DLQ |
| M7 | Consumer slower than producer | Backlog visible and bounded | Queue depth and age-of-oldest-message alarms, scaling policy |
| M8 | Duplicate consumers after a deploy | No double effect | M1 |
| M9 | Ordering required but partitioned wrongly | Related events land on one partition | Partition key = aggregate id |
| M10 | Replay of an old DLQ message after a schema change | Message rejected or upcast, never misparsed | Schema version in the envelope |

## Remote calls

| # | Failure | Expected behaviour | Mechanism |
| :-- | :--- | :--- | :--- |
| R1 | Read timeout on a state-changing call | State recorded as unknown, resolved by query | Explicit timeouts + status polling + `PENDING_UNKNOWN` |
| R2 | Connection refused | Fast failure, retried with backoff if idempotent | Connect timeout, exponential backoff with jitter |
| R3 | Dependency degraded (slow, not down) | Calls shed before pools exhaust | Circuit breaker with a defined fallback, bulkhead |
| R4 | 5xx from provider | Retry with backoff; bounded attempts | Retry policy with a total time budget |
| R5 | 4xx from provider | No retry; mapped to a domain error | Error classification table |
| R6 | Provider returns success late, after we gave up | Reconciliation finds it, state converges | Periodic reconciliation |
| R7 | Retry duplicates the effect | Provider deduplicates | Idempotency key sent on every attempt |
| R8 | Provider changes an error code | Unknown codes fail closed, alert | Default branch that does not silently succeed |
| R9 | TLS/cert expiry on the provider side | Clear failure, monitored | Alert on the error class, not only on the rate |

## Callbacks and webhooks

| # | Failure | Expected behaviour | Mechanism |
| :-- | :--- | :--- | :--- |
| C1 | Forged callback | Rejected before parsing | Signature verified, constant-time compare |
| C2 | Replayed callback | Rejected or absorbed | Timestamp window + event id uniqueness |
| C3 | Callback before the local record exists | Parked and retried, or upserted | Placeholder record, provider retry, or an inbox table |
| C4 | Callback arrives twice, concurrently | One winner, one no-op | Unique index, not `existsBy` |
| C5 | Callbacks out of order | Terminal states hold | Forward-only transitions |
| C6 | We return 500 to the provider | Provider retries; our retry budget is not exhausted by our own bug | Distinguish "retry me" from "do not retry" in the response |
| C7 | Provider stops sending callbacks | Detected within a bounded time | Reconciliation, or an alert on absence of traffic |

## Database and transactions

| # | Failure | Expected behaviour | Mechanism |
| :-- | :--- | :--- | :--- |
| D1 | Two concurrent updates to one aggregate | One fails and retries; no lost update | Optimistic locking (`@Version`) or `SELECT ... FOR UPDATE` |
| D2 | Read-then-write race on an invariant | Second writer rejected | Unique/check constraint at the database |
| D3 | Transaction holds a connection during a remote call | Does not happen | Remote calls outside the transaction boundary |
| D4 | Long transaction blocks a migration | Bounded statement/lock timeouts | `statement_timeout`, `lock_timeout` |
| D5 | Connection pool exhausted by a slow dependency | Requests shed rather than queue | Pool sizing + timeouts + breaker |
| D6 | Deadlock between two operations | Consistent lock ordering; retry on deadlock | Documented lock order |
| D7 | Rollback after an external effect | Compensation, or effect moved after commit | Outbox |

## Scheduling and batch

| # | Failure | Expected behaviour | Mechanism |
| :-- | :--- | :--- | :--- |
| B1 | Job runs on two instances | One runs | Leader election or a database advisory lock |
| B2 | Job misses a run | Next run catches up | Work selected by state, not by timestamp of the run |
| B3 | Job re-processes an item | No double effect | Idempotency again |
| B4 | Job runs longer than its interval | No overlap, or overlap is safe | Lock held for the duration |
| B5 | Partial batch failure | Successful items are not redone; failures are visible | Per-item state, not per-batch |

## Cross-cutting

| # | Failure | Expected behaviour | Mechanism |
| :-- | :--- | :--- | :--- |
| X1 | Our state and the provider's diverge | Detected daily, reported, resolvable | Reconciliation with a difference report |
| X2 | An operation is stuck in a non-terminal state | Detected by age, escalated | Alert on `state = PENDING AND age > threshold` |
| X3 | An incident requires knowing what happened | Reconstructable | Audit records with causation and correlation ids |
| X4 | Rollback of a deploy mid-migration | Old and new code both work against the schema | Expand/contract migrations |

## The two questions that generate most findings

1. **"What if this happens twice?"** — asked of every effect in the diff, not only the
   database write.
2. **"What if this succeeded but we never learned that it did?"** — asked of every
   remote call. The answer must not be "we treat it as failed".
