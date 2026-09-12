# Runtime settings that decide behaviour under stress

These values pass code review because they look like configuration. They are the
behaviour of the system under partial failure, and they are almost always inherited from
a template nobody re-derived for this workload.

Each entry gives the rule and the failure it prevents.

## SQS

| Setting | Rule | Failure it prevents |
| :--- | :--- | :--- |
| `visibility_timeout_seconds` | ≥ 6 × the consumer's timeout (AWS guidance for Lambda event source mappings) | The message reappears while the first consumer still holds it — the work runs twice |
| `redrive_policy.maxReceiveCount` | ≥ 5 for a Lambda consumer (AWS guidance), and bounded | Below it, a message that failed once or twice on a transient error lands in the DLQ; unbounded, a poison message consumes the queue's throughput until retention expires |
| DLQ | Always present, with its own alarm on depth > 0 | Silent loss; a DLQ nobody watches is a delayed delete |
| `message_retention_seconds` | Long enough to survive a weekend outage (4–14 days) | Losing the backlog while the fix is being written |
| `receive_wait_time_seconds` | 20 (long polling) | Empty-receive cost and needless latency |
| FIFO `content_based_deduplication` | Off unless the body is genuinely the identity | Distinct messages deduplicated away, or duplicates admitted |
| FIFO `MessageGroupId` | The aggregate id | Global ordering, which serialises the whole queue |

The DLQ needs its own redrive **allow** policy so a message can be moved back after a
fix, and someone needs to have done that once, in staging, before the night it matters.

## Lambda

| Setting | Rule | Failure it prevents |
| :--- | :--- | :--- |
| `timeout` | Just above the p99 of real work, not the 15-minute maximum | A hung dependency holding concurrency for a quarter of an hour |
| `reserved_concurrent_executions` | Set for any function fed by a burst source | One queue's spike exhausting account concurrency and throttling unrelated functions |
| Batch size + `ReportBatchItemFailures` | Enabled, with the handler returning the failed message ids | One bad record failing and replaying an entire batch |
| `maximum_retry_attempts` (async) | Explicit, with an on-failure destination | Silent discard after two invisible retries |
| Memory | Sized by measurement; CPU scales with memory | Paying for a slow function twice — in duration and in latency |
| VPC attachment | Only when it needs VPC resources | Cold-start ENI latency and NAT cost for nothing |
| Environment variables | Secrets from Secrets Manager / SSM at runtime, not plaintext in the config | Secrets in the console, in the state file, and in every `describe-function` |

## ECS Fargate

| Setting | Rule | Failure it prevents |
| :--- | :--- | :--- |
| `health_check_grace_period_seconds` | > real cold start (JVM + Spring context + warmup) | A crash loop where every task is killed before it can pass a health check |
| ALB `deregistration_delay` | ≥ the longest in-flight request | Dropped requests on every deploy |
| Container `stopTimeout` | > graceful shutdown period | SIGKILL mid-request |
| App graceful shutdown | `server.shutdown=graceful` + `spring.lifecycle.timeout-per-shutdown-phase` | The same, from the application side |
| ALB `idle_timeout` | > the slowest legitimate response | The LB closing a connection under a request that is still running — a 504 |
| App keep-alive timeout | > ALB `idle_timeout` (AWS's recommendation) | The app closing an idle connection the LB is about to reuse — a 502 attributed to the application |
| `deployment_circuit_breaker` | Enabled with `rollback = true` | A broken image rolling out to every task |
| `minimum_healthy_percent` / `maximum_percent` | 100 / 200 for a request-path service | Capacity dropping below demand during a deploy |
| JVM heap | `-XX:MaxRAMPercentage=75` or an explicit `-Xmx` | The JVM sizing against the host's memory and being OOM-killed |
| Health check endpoint | A real readiness check, not `return "OK"` | Traffic routed to a task whose database pool is empty |

Readiness and liveness are different questions. Readiness: can this instance serve
traffic right now (dependencies reachable, pool warm)? Liveness: is this process
irrecoverably stuck? Wiring a dependency check into liveness turns a downstream blip
into a restart storm.

## RDS / Aurora

| Setting | Rule | Failure it prevents |
| :--- | :--- | :--- |
| Pool size × task count | ≤ `max_connections` minus headroom for migrations, admin and the reader | Connection exhaustion at exactly the moment traffic peaks |
| `deletion_protection` | On, in every environment that has data anyone would miss | The one-line plan that deletes production |
| `backup_retention_period` | ≥ 7 days, and a restore actually tested | A backup that has never been restored is a hypothesis |
| `apply_immediately` | Understood per attribute; some force a restart | An unplanned restart in the middle of the day |
| `performance_insights_enabled` | On | Diagnosing a slow query from application logs alone |
| Statement and lock timeouts | Set at the connection or role level | One long transaction blocking a migration and then everything else |

The pool arithmetic, spelled out, because it is the one nobody does: 8 tasks × 20
connections = 160, plus 2 for the migration job, plus a reserved superuser connection,
against a `db.r6g.large` default of about 1,000 — fine. The same arithmetic on a
`db.t4g.medium` (about 340) with 20 tasks is not.

## Timeouts down the chain

One direction, stated once: **budgets shrink as you go deeper.** Every caller waits
longer than the total budget of everything it calls, so the innermost component fails
first and the failure travels back up as a real error. When the order inverts, the outer
caller gives up on a request that is still executing, retries it, and the retry lands on
a system already doing the work.

Derive the chain from the hard ceiling inward, not from the client outward. On AWS the
ceiling is usually API Gateway's integration timeout — 29 s for a REST API, fixed for
edge-optimized APIs and raisable by quota for Regional and private ones (at the cost of
some of the account's throttle quota):

```
API GW integration   >   ALB idle      >   service read   >   downstream read
     29s (ceiling)         25s               10s                 3s
```

Read it right to left: the PSP call gives up at 3 s, leaving the service 10 s to retry
once and still answer, leaving the ALB 25 s before it closes the connection under a
request that is still running, all inside the gateway's 29 s. Every value is set
explicitly; a missing read timeout defaults to infinity and removes the ceiling from the
chain entirely.

Two consequences worth checking on any diff that touches these:

- **The ALB idle timeout must exceed the slowest legitimate response**, or the load
  balancer abandons a request that is still running and answers 504. **The application's
  keep-alive must outlast the ALB idle timeout** — AWS's own recommendation — or the
  application closes a connection the load balancer is about to reuse, and the client gets
  a 502 attributed to the application.
- **Retry budgets are part of the arithmetic.** A service with a 10 s budget that retries
  a 3 s call three times has spent 9 s before its own overhead. Retries with exponential
  backoff and jitter, inside a stated total budget — fixed-interval retries from every
  instance reconverge into a synchronised burst.

## Alarms that must exist for a new component

A component with no alarm is invisible until a customer reports it. The minimum set:

| Signal | Example |
| :--- | :--- |
| Errors | 5xx rate, Lambda `Errors`, consumer exception rate |
| Latency | p99 above the SLO, sustained |
| Saturation | Queue depth, Lambda concurrency near the reserved limit, DB connections |
| Age | `ApproximateAgeOfOldestMessage`, oldest row in a non-terminal state |
| DLQ | Depth > 0, always, with no threshold debate |

The age alarm is the one most often missing and the one that catches the failures the
others do not: a consumer that is running, reporting no errors, and falling behind.
