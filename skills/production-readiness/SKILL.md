---
name: production-readiness
description: An evidence gate before a change is called done or released. Every claim must be backed by a command that was run and its output — build, tests, mutation score, security scan, migration safety, rollback plan, feature flag, alarms and runbook. Refuses to report completion on assumption. Use before merging or releasing, when writing a definition of done, when preparing a release checklist or a PR description, when a database migration or a feature flag is part of the change, or whenever an agent or a person is about to say the implementation is complete.
allowed-tools: Read, Grep, Glob, Bash(git status:*), Bash(git diff:*), Bash(git log:*), Bash(mvn -q clean compile:*), Bash(mvn -q verify:*), Bash(mvn -q test:*), Bash(mvn verify:*), Bash(mvn test:*), Bash(mvn org.pitest:*), Bash(./mvnw -q clean compile:*), Bash(./mvnw -q verify:*), Bash(./mvnw -q test:*), Bash(./mvnw verify:*), Bash(./mvnw test:*), Bash(./mvnw org.pitest:*), Bash(./gradlew test:*), Bash(./gradlew check:*), Bash(./gradlew pitest:*), Bash(npm test:*), Bash(npm run test:*), Bash(npm run lint:*)
license: MIT
---

# Production readiness

The failure this skill exists to prevent: **"the implementation is complete" written
without a single command having been run.** It is the most common failure of agentic
coding, and it is also a common failure of tired engineers on a Friday.

The rule is simple and it has no exceptions. **A claim without an artefact is not a
claim, it is a hope.** For each line below, either paste the command and its output, or
write `NOT VERIFIED` and say why. A gate with honest gaps is useful. A gate with
optimistic ticks is worse than no gate, because it transfers responsibility to whoever
believed it.

Invoke it deliberately at the end of a task — `/payment-grade:production-readiness`, or
`/production-readiness` when the skill was copied into `.claude/skills/` — rather than
waiting for it to trigger. The moment this skill is most needed is the
moment a session is most inclined to skip it.

## The evidence table

Fill this in. It is the output of the skill.

| # | Claim | Command | Result |
| :-- | :--- | :--- | :--- |
| 1 | It compiles | `mvn -q clean compile` | paste the last lines |
| 2 | Tests pass | `mvn -q verify` | counts: run / failed / skipped |
| 3 | New behaviour is covered | changed-code mutation run or the named tests | score, or the test names |
| 4 | Nothing else broke | full suite, not `-Dtest=TheOneIWrote` | counts |
| 5 | Lint / format clean | project's command | output |
| 6 | No secret added | `git diff --staged` scanned; scanner if present | output |
| 7 | Dependencies clean | SCA / image scan | critical + high counts |
| 8 | Migration is safe | see below | the plan |
| 9 | Contract is compatible | diff of the OpenAPI document | breaking changes: none / list |
| 10 | Config exists in every environment | new keys listed and located | list |
| 11 | It is observable | logs, metrics, trace, alarm | what fires and where |
| 12 | It can be turned off | flag or rollback | the exact procedure |

Rules for filling it in:

- **Run the commands.** Do not infer results from reading code. If a command cannot run
  in this environment, write `NOT VERIFIED — <reason>`; that is a legitimate outcome and
  it tells the reader exactly what a human still has to do.
- Row 4 exists because running only the new test is how a green tick accompanies a broken
  build. The full suite, or an honest `NOT VERIFIED`.
- Paste the tail of the real output, not a summary of it.

## Database migrations

The failures here are irreversible, which is why they get their own section.

- **Expand / contract.** A release never both adds and removes. Add the column (nullable
  or defaulted), deploy code that writes both and reads the new, backfill, and only in a
  **later** release drop the old. A migration that drops or renames in the same release
  as the code change cannot be rolled back, because the old code no longer has its column.
- **Locking.** On PostgreSQL, `ALTER TABLE ... ADD COLUMN` with a volatile default,
  adding a constraint without `NOT VALID`, or creating an index without `CONCURRENTLY`
  takes a lock that queues every query behind it. On a busy table that is an outage.
  Use `CREATE INDEX CONCURRENTLY`, then `ADD CONSTRAINT ... NOT VALID`, then `VALIDATE`.
- **Duration.** Estimate the migration's runtime against production row counts, not the
  local database with 200 rows.
- **Backfill** runs in batches, is restartable, and is not a single `UPDATE` over ten
  million rows inside the deploy.
- **Backward compatibility with the running version.** During a rolling deploy, the old
  and the new code run against the same schema simultaneously. Both must work.
- **The down path**: state it. "We would restore from backup" is an acceptable answer
  only if the restore time is acceptable and someone has performed one.

## Rollback

Answer three questions, concretely:

1. **How is this turned off?** A feature flag with a named key, a revert, or a
   redeploy of the previous image tag. Name it.
2. **How long does it take?** From the decision to the effect. If it is more than a few
   minutes for a change in a request path, that is a finding.
3. **What cannot be rolled back?** Messages already published, emails sent, money moved,
   rows dropped, an external system already told. Every irreversible effect must be
   listed here — that list is the real risk of the release.

A change behind a flag that has never been exercised in the off state has not been
tested in the off state. If the flag matters, prove both paths.

## Operability

- **Alarms**: does a failure of this change page anyone? Name the alarm. A new consumer,
  queue, endpoint or job with no alarm is not production-ready, it is production-hopeful.
- **Dashboards**: is the new behaviour visible — a counter, a latency histogram, a state
  distribution?
- **Logs**: enough to reconstruct a single transaction end to end (correlation id
  propagated across the queue boundary), and no sensitive data (see `payment-review`).
- **Runbook**: one paragraph. What breaks, how it looks, what to do first — written now,
  while the change is understood, rather than during the incident.
- **Load**: does the change alter the load on a shared dependency — more queries per
  request, a new N+1, a new call to a service sized for the old traffic?

## Security pass

Not a full audit; the four questions that catch most of it:

- New endpoint: authenticated **and** authorised at the object level?
- New input: validated at the boundary, with bounds on size and depth?
- New dependency: known, maintained, scanned, and actually needed?
- New secret: in the secret store, not in the repository, not in an environment block,
  not in the Terraform state?

## Output

```
READY: NO

Evidence table
| # | Claim | Command | Result |
| 2 | Tests pass | mvn -q verify | 412 run, 0 failed, 3 skipped |
| 4 | Nothing else broke | NOT VERIFIED — integration profile needs Docker, unavailable here |
| 8 | Migration is safe | expand/contract respected; CREATE INDEX lacks CONCURRENTLY |
...

BLOCKING
  - V12__add_index.sql creates an index without CONCURRENTLY on a 40M-row table:
    an exclusive lock for the duration of the build.
  - No alarm on the new DLQ.

BEFORE RELEASE
  - Run the integration profile on a machine with Docker.
  - Write the runbook paragraph.

IRREVERSIBLE IN THIS RELEASE
  - Events published to payment.events cannot be unpublished; consumers must
    tolerate the new field before this ships.
```

This skill decides a release, not a diff, so it does not grade findings — it lists
them in two buckets. `BLOCKING` is what the other skills call BLOCKER: the release
loses money or data, or cannot be undone. `BEFORE RELEASE` is everything that still
has to happen but does not have to happen now. A MAJOR finding from another skill
lands in `BLOCKING` when it is in the release path and in `BEFORE RELEASE` when it
is not.

`READY: YES` is only permitted when every row has an artefact and the blocking list is
empty. Anything else is `READY: NO` with the gaps listed. Saying "mostly ready" is how a
gate becomes decoration.
