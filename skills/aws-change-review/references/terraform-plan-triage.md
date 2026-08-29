# Reading a Terraform plan like a reviewer

The plan is the only artefact that says what will actually happen. Reviewing the `.tf`
diff without the plan misses everything that comes from a variable, a module version, a
data source, or state drift.

## Get the plan into a reviewable form

```bash
terraform plan -out=tfplan
terraform show -json tfplan > plan.json
```

Then extract the shape of the change before reading any detail:

```bash
# Every action, one line each
jq -r '.resource_changes[]
       | select(.change.actions != ["no-op"])
       | "\(.change.actions | join(",")) \(.address)"' plan.json | sort

# The dangerous subset, on its own
jq -r '.resource_changes[]
       | select(.change.actions | index("delete"))
       | .address' plan.json

# Why a resource is being replaced
jq -r '.resource_changes[]
       | select(.change.actions == ["delete","create"] or .change.actions == ["create","delete"])
       | "\(.address): \(.change.replace_paths // "unknown")"' plan.json
```

`replace_paths` names the attribute that forces the replacement. That attribute is the
finding — not the resource.

## The attributes that force replacement quietly

A change to any of these is a delete-and-create, even though the diff line looks like an
edit:

| Resource | Attribute | What is lost |
| :--- | :--- | :--- |
| `aws_sqs_queue` | `name`, `fifo_queue` | In-flight and delayed messages, the DLQ association |
| `aws_db_instance` / `aws_rds_cluster` | `identifier`, `engine_mode`, `db_subnet_group_name`, some `availability_zone` changes | The database, unless a snapshot is restored |
| `aws_dynamodb_table` | `name`, `hash_key`, `range_key`, `billing_mode` (some paths) | The table contents |
| `aws_elasticache_cluster` | `cluster_id`, `engine_version` (downgrade), `node_type` (some) | Cache contents; a cold cache is a load spike downstream |
| `aws_s3_bucket` | `bucket` | The bucket must be empty to destroy — the apply fails halfway instead |
| `aws_ecs_service` | `name`, `launch_type`, `cluster` | Service downtime during recreation |
| `aws_lambda_function` | `function_name`, `runtime` (some), `package_type` | Event source mappings, aliases, provisioned concurrency |
| `aws_iam_role` | `name` | Every trust relationship pointing at the old ARN |
| `aws_lb` | `name`, `internal`, `load_balancer_type` | The DNS name — anything hardcoding it breaks |
| `aws_subnet` / `aws_vpc` | `cidr_block` | Everything inside |

Renaming a resource **in Terraform** (the address, not the AWS name) also produces a
destroy/create unless it is moved:

```hcl
moved {
  from = aws_sqs_queue.events
  to   = aws_sqs_queue.payment_events
}
```

A plan showing a destroy and a create of the same underlying resource is almost always a
missing `moved` block or a missing `terraform state mv`. Say so — it is a five-line fix
instead of an outage.

## Guards worth requiring on stateful resources

```hcl
resource "aws_rds_cluster" "payments" {
  # ...
  deletion_protection = true

  lifecycle {
    prevent_destroy = true

    ignore_changes = [
      # attributes AWS or another process mutates, which otherwise produce
      # a permanent diff and tempt someone into a destructive "fix"
      availability_zones,
    ]
  }
}
```

`prevent_destroy` fails the plan rather than the apply, which is exactly the right time
to fail. When a destroy is genuinely intended, it is removed in its own commit — which
makes the intent reviewable.

For anything in a request path, `create_before_destroy` turns a replacement into a
rolling change:

```hcl
lifecycle {
  create_before_destroy = true
}
```

It requires a name that is not fixed (`name_prefix`, or a name derived from a hash),
because the old and the new resource coexist for a moment.

## Partial apply

Terraform applies resource by resource. A failure at resource 40 of 60 leaves the first
39 applied. Before an apply that includes any destroy or replace, ask:

- Is the change **ordered** such that a stop in the middle leaves a working system? If a
  security group is replaced before the thing that depends on it is updated, the middle
  state is an outage.
- Can the apply be **split**? `-target` is a code smell in normal operation and the right
  tool for a risky change: apply the additive part, verify, then the destructive part.
- Is the state **locked**? Without DynamoDB or S3 native locking, two concurrent applies
  corrupt the state, and recovering a corrupted state under incident pressure is the
  worst hour of that week.

## State hygiene, checked once per review

- Backend is S3 (or equivalent) with **versioning on**, encryption on, and access
  restricted to the deploy role. State versioning is the only undo that exists.
- No secret is passed as a variable that ends up in state. Every value Terraform manages
  is in the state file in plaintext — including RDS passwords, generated keys, and any
  `sensitive = true` variable, whose marking only hides it from CLI output.
- Provider versions pinned (`~>`), module sources pinned to a tag or a commit, and a
  committed lock file. An unpinned module means the plan you reviewed is not the plan
  that applies tomorrow.
- Workspaces or separate state files per environment, never one state holding both
  staging and production.

## Drift

`terraform plan` on an unchanged branch should be empty. If it is not, someone changed
something in the console, and the next apply will revert it — possibly during an
unrelated deploy, possibly the fix an on-call engineer applied at 3am.

A plan that contains changes the author did not write is a stop condition. Identify them
before applying anything:

```bash
jq -r '.resource_changes[]
       | select(.change.actions != ["no-op"])
       | select(.address | test("expected_prefix") | not)
       | .address' plan.json
```

## The review's closing questions

1. What is destroyed or replaced, and what data goes with it?
2. What is the state of the world if the apply stops halfway?
3. What restores the previous state, and how long does it take?
4. Was this plan produced from the commit being reviewed, against the target environment?

An apply approved without answers to those four is a decision made by whoever runs it.
