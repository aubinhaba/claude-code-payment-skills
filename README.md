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
PLAN SUMMARY: no plan supplied; reviewed the diff (terraform/modules/sqs). Not a destroy
or replace. Two in-place changes per queue, plus a likely update of the DLQ.
VERDICT: DO NOT APPLY

BLOCKER  module.sqs*.aws_sqs_queue.main  redrive_policy removed
  Consequence: the main queue has no DLQ. A poison message loops until retention
  expires, and messages that exhaust retries are deleted rather than parked. The
  DLQ is still created (retention 14 days) but nothing feeds it, so it is dead
  weight. For payment-events that is silent loss of payment events.
  Fix: restore redrive_policy. (The same applies to anomaly-analysis, which sets
  max_receive_count = 2 in dev/main.tf:87. That argument is now accepted and
  silently ignored.)

MAJOR    payment-events  visibility_timeout default 300s -> 30s
  Consequence: this caller does not override the value, so it takes the new default.
  Any consumer that takes more than 30s sees the message reappear while the first
  attempt is still running, and the work is done twice.
  Note: anomaly-analysis overrides this (600s), so it is unaffected. The
  override you can see is the safe one.

[... one more BLOCKER, one MAJOR, a MINOR and two NOTEs ...]

PRECONDITIONS BEFORE APPLY:
  1. Restore redrive_policy and kms_master_key_id, and revert the two defaults
     (or justify them with the consumer's measured processing time).
  [... 2 ...]
  3. Provide the tfplan JSON showing the actions are "update" only.
  [... 4 ...]
ROLLBACK: `git checkout` the two files and re-apply. The queue attributes are
  in-place and reversible within minutes. Messages already deleted by 1-hour
  retention, or dropped without a DLQ in the interim, cannot be recovered.
```

One real run of `aws-change-review` over a Terraform diff that took the redrive policy and
the KMS key off a shared SQS module — cut for length, never reworded. What that shape buys:
a decision instead of an inventory, severities that give an order of attack, the per-caller
distinction that says which queue actually breaks, what has to be true before the apply, and
a rollback that names the part no rollback reaches. Every finding names a failure scenario —
*"consider using a Money object"* is noise, *"a EUR refund against a USD capture passes this
check"* is a finding.

[![Validate](../../actions/workflows/validate.yml/badge.svg)](../../actions/workflows/validate.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![Claude Code](https://img.shields.io/badge/Claude%20Code-plugin-black)
![No dependencies](https://img.shields.io/badge/dependencies-none-brightgreen)

## Install

```bash
/plugin marketplace add aubinhaba/claude-code-payment-skills
/plugin install payment-grade@claude-code-payment-skills
```

Invoke one directly: `/payment-grade:payment-review`. A skill can also be picked up on its own
from the `description` in its frontmatter, but nothing here measures how reliably that happens,
so name the one you want when it matters.
No plugin? Copy any directory from `skills/` into `.claude/skills/` — each is self-contained,
and is then invoked without the prefix, as `/payment-review`.
The hooks need `node` on the `PATH`. If it is missing, each hook fails to start and Claude
Code carries on without it: the guards simply do not run.

## The six skills

The failure modes are stack-independent; the examples and tooling are Java, Spring Boot and
AWS because that is where they were learned.

| Skill | Reviews | The question it asks first, every time |
| :--- | :--- | :--- |
| **`payment-review`** | Money and card data | Does this change put a component inside PCI scope that was outside it yesterday? |
| **`consistency-review`** | Event-driven and integration code | What happens when this is delivered twice, out of order, or succeeds without us learning that it did? |
| **`boundaries-review`** | Hexagonal / DDD structure | Is the layering enforced by a test, or by everyone remembering? |
| **`test-strength-review`** | Test quality | Which change to production code would these tests fail to notice? |
| **`aws-change-review`** | Terraform plans and AWS runtime config | What does this destroy, and what is the state of the world if the apply stops halfway? |
| **`production-readiness`** | The claim that work is done | Which command was actually run, and what did it output? |

Each skill body stays short, and the bulky material sits in `references/`. That split only
works if the body actually sends the reader to the file: `See x.md for the rules` reads as a
summary of the file and gets skipped. So every pointer names the condition that makes the
file worth opening, and `scripts/validate-pack.js` fails a pointer that is a summary.

## The three hooks

Skills tell Claude how to work. Hooks decide what cannot happen at all — they run outside
the model's control, regardless of what it intended.

| Hook | Fires on | Denies or asks |
| :--- | :--- | :--- |
| `guard-card-data` | `Write`, `Edit`, `MultiEdit`, `NotebookEdit`, and the file-writing forms of `Bash` and `PowerShell` | A Luhn-valid PAN outside test paths, a card-number field on a logging line, AWS access key ids, private keys, Stripe `sk_live_` keys, GitHub and Slack tokens. Asks on a CVV in a persistence or logging context |
| `guard-destructive-commands` | `Bash` | `terraform destroy`, `apply -destroy`, `apply` without a saved plan, recursive S3 deletes, `purge-queue`, destructive DDL, force-push to a shared branch. Asks on IAM/KMS changes and `DELETE` without `WHERE` |
| `guard-unverified-completion` | `Stop` | Ending a turn when a source file was modified in the session and no build, test or plan command ran after it |

On the shell path the card guard reads the command, not the bytes it will produce, so it
**asks and never refuses** there: a value that arrives through a variable or a pipe is
invisible to it.

What they still do not see: a PAN assembled at runtime or encoded; a write through a
language runtime (`python -c`, `node -e`) rather than a shell redirect; and, for the Stop
gate, any runner outside its list. It judges the session rather than the turn. Every error
path exits without a decision and without a message, so a guard that fails open does so
silently.

## Verify

The skills refuse a claim with no command behind it. The pack holds itself to the same rule,
on Linux, Windows and macOS in CI:

```bash
node scripts/validate-pack.js
npm test
```

MIT — see [LICENSE](LICENSE).
