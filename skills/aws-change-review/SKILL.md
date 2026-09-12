---
name: aws-change-review
description: Reviews an infrastructure change before it is applied. Triages a Terraform plan for destructive and replacing changes, widened IAM, exposed network paths and secrets in state; then checks the runtime settings that decide whether the service survives contact with production — timeouts, SQS visibility and redrive, Lambda concurrency, ECS health checks and draining, connection pools, alarms. Use when reviewing Terraform, CloudFormation or CDK changes, a terraform plan output, or an AWS service configuration; when the diff contains .tf, .tfvars or .hcl files, a task definition, a Lambda, SQS, ALB or RDS configuration, or an IAM policy; when someone pastes a terraform plan and asks what it will do; or before an apply to production.
allowed-tools: Read, Grep, Glob, Bash(git diff:*), Bash(terraform show:*), Bash(terraform validate:*), Bash(terraform fmt -check:*)
license: MIT
---

# AWS change review

Two failure classes, again. **The plan does something irreversible that nobody read**,
and **the resource is configured in a way that only fails under load or partial
failure**. A plan review that only checks resource naming has reviewed the first ten
percent.

Never run `terraform apply`. Never run `terraform plan` against an environment without
being asked. Read the plan the author provides, or ask for `terraform show -json
tfplan | jq` output.

## 1. Triage the plan

Classify every change before commenting on any of it:

| Class | Signal in the plan | Review stance |
| :--- | :--- | :--- |
| Destroy | `- resource` | Stop. Name what is lost and whether it is recoverable. |
| Replace | `-/+` or `+/-`, "must be replaced" | Stop. Identify the forcing attribute and the downtime. |
| In-place, widening | `~` on a policy, CIDR, or public flag | Check the blast radius. |
| In-place, neutral | `~` on a tag, description, log retention | Note and move on. |
| Create | `+` | Check defaults; new resources arrive with the provider's defaults, not yours. |

`-/+` on a stateful resource is the one that ends up in a post-mortem. Databases, EBS
volumes, S3 buckets, ElastiCache clusters, SQS queues with in-flight messages, EFS. A
rename that looks cosmetic — an SQS queue `name`, an RDS `identifier`, a DynamoDB table
`name` — forces replacement and takes the data with it.

Ask for these before an apply that contains any replace or destroy:

- `prevent_destroy` on stateful resources (`lifecycle { prevent_destroy = true }`);
- a snapshot or backup taken and verified, with its identifier;
- `create_before_destroy` where the resource is in a request path;
- the rollback: what re-creates this if the apply fails halfway.

**Partial apply is the normal failure mode.** Terraform is not transactional. For any
plan with more than a handful of resources, ask what the world looks like if it stops in
the middle, and whether the next apply is safe to run.

Read the plan as JSON rather than as text where the plan is large: `terraform show -json
tfplan` lists every `resource_changes[].change.actions`, which is where a destroy or a
replace hides in a wall of diff.

## 2. IAM, network, secrets

- **IAM**: `"Action": "*"`, `"Resource": "*"`, `iam:PassRole` without a condition,
  `sts:AssumeRole` with a wildcard principal, or a managed policy where an inline scoped
  one was intended. Compare against the previous policy — the finding is the *widening*,
  not the absolute permissiveness of a policy that already existed.
- **Security groups**: `0.0.0.0/0` on anything other than 80/443 on a public ALB. An
  egress rule to `0.0.0.0/0` from a CDE subnet is a finding of its own.
- **Public exposure**: `publicly_accessible` on RDS, a public subnet for a task that has
  no reason to be there, an S3 bucket losing `block_public_acls`, an API Gateway moving
  from private to regional.
- **Secrets**: a value in `.tfvars`, in a `default =`, in a task-definition
  `environment` block instead of `secrets`, or in a Lambda environment variable. All of
  these end up in the Terraform state file, which is a plaintext JSON document. Check
  the state backend is encrypted, versioned, access-restricted, and locked (DynamoDB or
  S3 native locking).
- **Encryption and retention**: KMS on new stateful resources, log-group retention set
  (the default is "forever", which is a cost line and a data-retention obligation).

## 3. Runtime settings that decide behaviour under stress

These are configuration values, so they pass review by looking plausible. They are the
ones that produce the incident. `references/runtime-settings.md` holds the full table
with the failure each rule prevents; the checks below are the ones worth doing on every
change.

**SQS → Lambda**
- Queue `visibility_timeout` must be **at least 6× the Lambda timeout** (AWS's own
  guidance for event source mappings). Below that, the message reappears while the first
  invocation is still running and the work is done twice.
- `redrive_policy` present, with a `maxReceiveCount` of at least 5 — AWS's guidance for
  Lambda event sources, so a message gets a few retries before it is sent to the DLQ. No
  DLQ means a poison message loops until the retention period expires.
- Alarm on the DLQ depth. A DLQ without an alarm is a delete with extra latency.
- Reserved concurrency: without it, a burst on this queue consumes the account's
  concurrency and takes unrelated functions down. With it set too low, the queue backs
  up silently — so pair it with an age-of-oldest-message alarm.
- Batch size and partial batch failure: with `ReportBatchItemFailures`, a single bad
  record must not fail the whole batch. Check the handler returns the failure list.

**ECS Fargate**
- Health check path, interval, and `health_check_grace_period_seconds` longer than the
  application's real cold start. Too short and the service kills every task before it
  can register, in a loop that looks like a crash.
- ALB `deregistration_delay` ≥ the longest in-flight request, and the container handling
  SIGTERM with a graceful shutdown (`server.shutdown=graceful`,
  `spring.lifecycle.timeout-per-shutdown-phase`). Otherwise every deploy drops requests.
- `stopTimeout` greater than the graceful shutdown period.
- ALB idle timeout **greater than** the slowest legitimate request, or the load balancer
  gives up on a request still running and answers 504. And the application's keep-alive
  timeout **greater than** the ALB idle timeout, or the application closes connections the
  load balancer is about to reuse, and each one becomes a 502 attributed to the app.
- `deploymentConfiguration`: `minimumHealthyPercent` / `maximumPercent` allowing a
  rolling deploy without dropping below capacity; circuit breaker with rollback enabled.
- CPU/memory: a JVM without container-aware heap settings will size against the host it
  thinks it has. Check `-XX:MaxRAMPercentage` or an explicit heap.

**RDS / Aurora**
- Connection pool size × task count ≤ instance `max_connections`, with headroom for
  migrations and admin sessions. This is arithmetic and it is almost never done.
- Multi-AZ, backup retention, deletion protection, `apply_immediately` (which on some
  attributes means "cause a restart now").
- Parameter group changes marked `pending-reboot` versus `immediate` — the plan shows
  the change, not when it takes effect.
- Any `-/+` on the cluster: this is the destroy case, treated as a configuration line.

**API Gateway / ALB / clients**
- Every timeout set explicitly, and the budgets shrinking as the chain goes deeper:
  gateway > load balancer > service > downstream call. Derive it from the ceiling inward —
  API Gateway's 29 s integration timeout on a REST API, fixed for edge-optimized APIs and
  raisable by quota for Regional and private ones — not from the client outward. Where the order inverts, the outer caller abandons a request that is still
  running, retries stack, and one slow dependency becomes a full outage.

## 4. Observability and cost, briefly

- Does the change add a component with **no alarm**? A new queue, function or service
  that cannot page anyone is invisible until a customer reports it.
- Are the four that matter present: error rate, latency, saturation (queue depth /
  concurrency / connections), and age of the oldest unprocessed item?
- Log retention set. Sampling on traces. A new log group at full verbosity in a
  high-traffic path is a five-figure surprise.
- NAT gateway data processing, cross-AZ traffic, provisioned concurrency and `gp3` vs
  `io2` are where infrastructure cost decisions actually get made. Flag them as NOTE,
  not as blockers.

## Output format

```
PLAN SUMMARY: 4 to add, 3 to change, 1 to destroy, 1 to replace
VERDICT: DO NOT APPLY | APPLY WITH PRECONDITIONS | SAFE TO APPLY

BLOCKER  aws_sqs_queue.payment_events  must be replaced (name changed)
  Consequence: in-flight messages are lost; the DLQ is recreated empty; consumers
  keep the old URL until their next deploy.
  Precondition: drain the queue, or keep the name and change only the tags.

MAJOR    aws_sqs_queue.payment_events  visibility_timeout 30s, consumer timeout 30s
  Consequence: at 1x the message reappears while the first invocation still runs;
  every slow message is processed twice.
  Fix: visibility_timeout_seconds >= 180 (6x the Lambda timeout).

PRECONDITIONS BEFORE APPLY:
  1. Snapshot <identifier> taken and verified
  2. Apply during the low-traffic window, one target at a time
ROLLBACK: <what restores the previous state, and how long it takes>
```

Severity, so that two skills reviewing one diff produce comparable verdicts:

| Level | Threshold |
| :--- | :--- |
| **BLOCKER** | Merging this loses money or data, or produces an audit finding. |
| **MAJOR** | A defect that will surface in production under load or partial failure. |
| **MINOR** | A maintenance cost, or a defect bounded to a single caller. |
| **NOTE** | Something the author should know. No action required. |

One BLOCKER is enough for DO NOT APPLY. MAJOR findings alone are
APPLY WITH PRECONDITIONS, and every precondition is listed below the findings.

Always end with the preconditions and the rollback. A plan review that does not say how
to undo the change has not finished.
