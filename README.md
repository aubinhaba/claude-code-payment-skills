# claude-code-payment-skills

**Six review skills and three guard hooks for Claude Code, built for backends where a
silent defect costs money.**

Green test suite, clean review, found at reconciliation three weeks later. This pack
encodes the two failure classes that get past all three: a change that quietly widens PCI
scope, and a change that breaks under a partial failure nobody simulated.

**Built for Java and Spring Boot services on AWS**, with Maven or Gradle, PIT, ArchUnit and
Terraform. The failure modes hold in any stack; the commands, configurations and tooling
advice do not. On a Node or Python codebase expect findings you will have to translate —
and PIT or ArchUnit advice you cannot use.

```
VERDICT: REQUEST CHANGES

BLOCKER  OrderService.java:88  Charge retried without an idempotency key
  Interleaving: the PSP receives the first POST, responds after our 2s read timeout,
  the retry creates a second charge. The customer is debited twice.
  Fix: send the same Idempotency-Key header on every attempt of one logical charge.

| # | Failure                          | Expected                   | Mechanism            | Present |
|---|----------------------------------|----------------------------|----------------------|---------|
| S1| Message delivered twice          | Second is a no-op          | Unique index on key  | yes     |
| S2| Authorization times out          | PENDING_UNKNOWN, polled    | Timeout + status job | **no**  |

NOT REVIEWED: infrastructure/, generated DTOs
```

Every finding names a failure scenario. *"Consider using a Money object"* is noise;
*"a EUR refund against a USD capture passes this check"* is a finding. The table is the
part worth pasting into the pull request.

[![Validate](../../actions/workflows/validate.yml/badge.svg)](../../actions/workflows/validate.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![Claude Code](https://img.shields.io/badge/Claude%20Code-plugin-black)
![No dependencies](https://img.shields.io/badge/dependencies-none-brightgreen)

## Install

```bash
/plugin marketplace add aubinhaba/claude-code-payment-skills
/plugin install payment-grade@claude-code-payment-skills
```

Skills load on their own when a diff matches, or invoke one with `/payment-grade:payment-review`.
No plugin? Copy any directory from `skills/` into `.claude/skills/` — each is self-contained,
and is then invoked without the prefix, as `/payment-review`.
The hooks need `node` on the `PATH`. If it is missing, each hook fails to start and Claude
Code carries on without it: the guards simply do not run.

## The six skills

The failure modes are stack-independent; the examples and tooling are Java, Spring Boot and
AWS because that is where they were learned.

| Skill | Reviews | The question it asks that others do not |
| :--- | :--- | :--- |
| **`payment-review`** | Money and card data | Does this change put a component inside PCI scope that was outside it yesterday? |
| **`consistency-review`** | Event-driven and integration code | What happens when this is delivered twice, out of order, or succeeds without us learning that it did? |
| **`boundaries-review`** | Hexagonal / DDD structure | Is the layering enforced by a test, or by everyone remembering? |
| **`test-strength-review`** | Test quality | Which change to production code would these tests fail to notice? |
| **`aws-change-review`** | Terraform plans and AWS runtime config | What does this destroy, and what is the state of the world if the apply stops halfway? |
| **`production-readiness`** | The claim that work is done | Which command was actually run, and what did it output? |

Each skill stays short and keeps its long material in `references/`, loaded only when the
review needs it.

## The three hooks

Skills tell Claude how to work. Hooks decide what cannot happen at all — they run outside
the model's control, regardless of what it intended.

| Hook | Fires on | Denies or asks |
| :--- | :--- | :--- |
| `guard-card-data` | `Write`, `Edit`, `MultiEdit`, `NotebookEdit` | A Luhn-valid PAN outside test paths, a card-number field on a logging line, AWS access key ids, private keys, Stripe `sk_live_` keys, GitHub and Slack tokens. Asks on a CVV in a persistence or logging context |
| `guard-destructive-commands` | `Bash` | `terraform destroy`, `apply` without a saved plan, recursive S3 deletes, `purge-queue`, destructive DDL, force-push to a shared branch. Asks on IAM/KMS changes and `DELETE` without `WHERE` |
| `guard-unverified-completion` | `Stop` | Ending a turn when a source file was modified in the session and no build, test or plan command ran after it |

What they do not see: commands sent through the PowerShell tool, and files written by a
shell redirect or `sed -i`; a PAN assembled at runtime or encoded; and, for the Stop gate,
anything outside its runner list — it knows `mvn`, `gradle`, `npm`, `pytest`, `go`, `cargo`,
`tsc` and `terraform`, not `node --test`, `npx vitest` or `npx jest`. It judges the session
rather than the turn. Every error path exits without a decision and without a message, so a
guard that fails open does so silently.

## Verify

The skills refuse a claim with no command behind it. The pack holds itself to the same rule,
on Linux, Windows and macOS in CI:

```bash
node scripts/validate-pack.js
npm test
```

MIT — see [LICENSE](LICENSE).
