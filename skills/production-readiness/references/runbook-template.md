# Runbook — one page, written before the release

A runbook written during an incident is written by someone who no longer remembers the
design and is being asked for an ETA. Write it while the change is fresh; it takes ten
minutes and it is read at 3am by someone who was not in the room.

Keep it to one page. A twelve-page runbook is not read.

---

## `<component>` — runbook

**What it does, in two sentences.**
Consumes `payment.events` and updates the merchant balance projection. Nothing in the
payment path depends on it synchronously.

**Owner / escalation.** Team, channel, and who to wake if the first responder is stuck.

**Blast radius if it is completely down.** Balances go stale; payments continue
normally; the projection catches up when the consumer resumes. *(This sentence decides
whether the responder pages a second person or goes back to sleep.)*

### Signals

| Alarm | What it means | First action |
| :--- | :--- | :--- |
| `payment-events-dlq-depth > 0` | At least one message failed 5 times | Inspect the message; see *DLQ replay* |
| `payment-events-age > 15min` | Consumer running but falling behind | Check task count and the database pool |
| `balance-projection-5xx > 1%` | Downstream write failing | Check the database, then the recent deploy |

### Diagnosis, in order

1. Was there a deploy in the last hour? `<link to the deploy history>` — if yes, consider
   rollback before diagnosing further.
2. Is the consumer running? `aws ecs describe-services --cluster <c> --services <s>`
3. Is it consuming? Queue depth trend on `<dashboard link>`.
4. Errors: `<saved log query>` filtered on the last 15 minutes.
5. Is the dependency healthy? `<dependency dashboard>`.

### Recovery

**Rollback**: `<exact command or pipeline job>`. Takes about N minutes. Safe at any time
because `<reason>`.

**Feature flag**: `<flag key>`, set to `off` at `<location>`. Effect within N seconds.

**DLQ replay**: after the cause is fixed, `<command or console procedure>`. Messages are
idempotent by `<key>`, so replay is safe. Replay in batches of N and watch the error rate.

**Scale up**: `<command>`, and the ceiling that must not be crossed (`<reason>` — usually
the database connection pool).

### Known false alarms

- The age alarm fires for ~2 minutes during a deploy while tasks drain. Only page if it
  persists past 5 minutes.

### What must never be done here

- Do not purge the queue to clear an alert. Those messages are the state change.
- Do not increase the pool size past N; the database will reject connections and the
  outage widens to every service on that cluster.

---

## Writing rules

- **Commands, not descriptions.** "Check the logs" is not a step. The saved query is.
- **Links that resolve** to the dashboard, the pipeline, the alarm.
- **The blast-radius sentence first.** Most of a responder's stress is not knowing how
  bad it is.
- **The "never do this" section** is the most valuable part and the most often missing.
  It is where the last incident's lesson lives.
- Update it after every incident that used it. A runbook that was wrong once and stayed
  wrong is worse than none.
