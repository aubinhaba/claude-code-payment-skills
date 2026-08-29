---
name: test-strength-review
description: Judges whether tests actually detect defects, rather than whether they exist. Uses mutation testing as the measure, reviews assertion quality, over-mocking, contract tests against external providers, and what a test suite cannot cover. Use when the diff adds or modifies tests, when coverage is high but bugs still ship, when someone cites a line-coverage percentage, when setting or arguing about a quality gate, when configuring PIT, JaCoCo or SonarQube gates, when a change touches WireMock stubs or Testcontainers setup, or when asked to add tests to a change or whether the existing tests are any good.
allowed-tools: Read, Grep, Glob, Bash(git diff:*), Bash(mvn test:*), Bash(mvn verify:*), Bash(mvn org.pitest:*), Bash(./mvnw test:*), Bash(./mvnw verify:*), Bash(./mvnw org.pitest:*), Bash(./gradlew test:*), Bash(./gradlew pitest:*)
license: MIT
---

# Test strength review

Line coverage measures which lines ran. It says nothing about whether a wrong result
would have been noticed. A suite at 85% coverage whose assertions are `assertNotNull`
detects almost nothing, and the number on the dashboard is the reason nobody looks.

The measure that means something is **mutation score**: change the production code in
small ways, and count how many of those changes make a test fail. A surviving mutant is
a defect the suite would not catch.

Review in this order.

## 1. Assertion quality

Read the assertions before anything else. The common failures, in descending frequency:

| Smell | Why it detects nothing | What to ask for |
| :--- | :--- | :--- |
| `assertNotNull(result)` | Passes for every wrong value | Assert the value |
| Only `verify(mock).method(any())` | Asserts that code ran, not that it was right | Assert the observable outcome; keep `verify` for effects with no return |
| Asserting on a mock's own return | Tests the stub, not the code | Assert on what the code computed from it |
| One assertion per field, no invariant | Passes while the whole is inconsistent | Assert the aggregate: totals sum, states hold |
| `assertThat(list).hasSize(3)` | Same size, wrong content | Assert the content, or the element that matters |
| No negative case | Only the happy path is protected | The error path, with the message or type asserted |
| `assertTrue(x.equals(y))` on a class without `equals` | Reference identity passes accidentally | Field-by-field or a proper `equals` |
| Snapshot/approval of a large object | Rewritten on every failure, so it asserts nothing | Assert the fields the behaviour is about |

A test whose name says `shouldWork` and whose body has one loose assertion is not
coverage of the behaviour, it is coverage of the lines.

## 2. Mutation score, and where to demand it

If the project runs PIT (or Stryker, or `cargo-mutants`), read the report and review the
**surviving mutants in the changed code**, not the global percentage. Each survivor is a
concrete question: "if this `>=` were `>`, which test would fail?" If the answer is none,
that is the finding — and it names the missing test precisely.

If the project does not run mutation testing, propose it *scoped*: on the domain and
application packages, on changed classes in merge-request pipelines, with a threshold
that starts where the code is today. `references/pitest-setup.md` has a Maven
configuration and a CI job that stay under a few minutes.

Where a high threshold (85–95%) is worth its cost:

- domain rules, money arithmetic, state machines, validators, allocation and rounding;
- anything whose failure is silent — a wrong amount, a wrong status, a wrong routing.

Where demanding it is theatre:

- generated code (OpenAPI DTOs, MapStruct implementations, Lombok);
- configuration classes and wiring;
- adapters that are a single delegation, whose value is proven by an integration test;
- equals/hashCode/toString.

Say this out loud in the review. A blanket 90% across the whole module is how teams
learn to write assertions that satisfy the tool.

## 3. Mocking

- **Mock what you do not own, at the boundary.** Mocking your own domain objects makes
  the test assert your assumptions about them rather than their behaviour.
- A test with more `when(...)` lines than assertion lines is describing a call sequence.
  It will fail on every refactoring and pass through every behaviour change — exactly
  backwards.
- Prefer a real object over a mock whenever it is cheap: in-memory repository fakes,
  a fixed `Clock`, a deterministic id generator. Injected `Clock` and id supplier are
  what make time-dependent and idempotency behaviour testable at all.
- For the external provider, prefer a **stub server** (WireMock) over a mocked client:
  it exercises serialisation, error mapping, timeouts and retries, which is where
  integration defects actually live.

## 4. What integration tests must cover

Unit tests cannot see these; if the change touches them, an integration test is not
optional:

- the outbox → publisher → consumer path, including a duplicate delivery;
- database constraints that carry an invariant (the unique index that stops the double
  refund must be proven to stop it);
- transaction rollback behaviour;
- error mapping from the provider's real response bodies and status codes;
- timeout and retry behaviour, with a delayed stub response;
- schema migrations against a real engine — not H2 standing in for PostgreSQL.

Testcontainers for the database and the queue; WireMock for the provider, with stubs
generated from the provider's published contract where one exists.

## 5. What cannot be tested, and the compensation

Every honest suite has a gap. Name it, then name what covers it:

| Not testable | Compensation |
| :--- | :--- |
| The provider's real behaviour on an edge case | A sandbox smoke test on a schedule, and an alert on unknown error codes |
| Production data shapes | A contract check on ingestion, and a reconciliation report |
| Rare interleavings | The failure-mode table from `consistency-review`, plus a chaos test on the critical path |
| Performance under real load | A load test at release milestones, and a latency SLO with an alert |

A review that lists this table has said something a coverage percentage cannot.

## Output format

```
VERDICT: REQUEST CHANGES | APPROVE WITH FOLLOW-UPS | APPROVE

MAJOR   RefundServiceTest.java:42  Assertion cannot fail
  The test asserts refund != null. Changing the refunded amount to zero keeps it green.
  Surviving mutant: RefundService:88 replaced `amount` with `ZERO` — no test failed.
  Fix: assert the refunded Money equals the requested Money and the payment total.

MAJOR   (module)  Unique index on (merchant_id, idempotency_key) is untested
  Nothing proves the constraint stops a concurrent duplicate; it can be dropped by a
  migration without any test noticing.
  Fix: integration test inserting the same key twice, asserting the second fails.

COVERAGE GAPS THAT ARE ACCEPTABLE: <list, with the compensating control>
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

Never report a coverage percentage as a finding. Report the behaviour that is not
protected, and the change to production code that would go unnoticed.
