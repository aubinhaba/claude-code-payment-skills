---
name: boundaries-review
description: Reviews architectural boundaries in a hexagonal or layered service. Checks dependency direction, framework and persistence leakage into the domain, transaction boundaries, contract-first API generation, mapper placement, and whether the rules are enforced by a test rather than by discipline. Use when reviewing a new module or package, a change that crosses layers, an entity or DTO change, a repository or adapter; when the diff adds a package, moves a class between layers, introduces a new adapter or port, changes @Transactional placement, or adds annotations to a domain class; or when asked for an architecture review, an ArchUnit rule, or whether a design respects hexagonal architecture, DDD boundaries and a framework-free domain.
allowed-tools: Read, Grep, Glob, Bash(git diff:*), Bash(git log:*), Bash(git show:*)
license: MIT
---

# Boundaries review

Hexagonal architecture is not a folder layout. It is one rule — **the domain depends on
nothing** — and a set of tests that make violating it fail the build. A review that
praises the folder names while the domain imports `jakarta.persistence` has reviewed
nothing.

Target shape:

```
api ──────┐
          ▼
     application ────► domain ◄──── infrastructure
```

`api` and `infrastructure` depend inward. `domain` depends on nothing. `application`
orchestrates and depends only on `domain` and on ports it declares.

## 1. Dependency direction

Read the imports, not the package names.

- Does anything in `domain` import Spring, Jakarta/JPA, Jackson, an SDK, a generated
  DTO, or a class from `infrastructure`? Each one is a finding. `@Component` on a domain
  service and `@Entity` on an aggregate are the two most common.
- Does `application` import `infrastructure` concretely, rather than a port it owns?
  The port interface belongs to the inside; the implementation to the outside. A port
  declared in the `infrastructure` package is an inverted dependency that only looks
  right.
- Do `api` and `infrastructure` reference each other directly, bypassing the middle?
  A controller calling a repository skips the layer where the invariants live.
- Is there a cycle between modules? In a Maven multi-module build the compiler stops it;
  in a single module only a test does.

Argue about naming only if the name misleads about direction. Otherwise it is noise.

## 2. What the domain is allowed to be

The domain should compile with no framework on the classpath, and should be testable
without a Spring context, a database or a mock. If a domain test needs `@SpringBootTest`,
the boundary has already failed.

Look for:

- Persistence concerns: lazy-loading assumptions, `@ManyToOne` graphs used as the domain
  model, `Optional` fields shaped by the ORM, entities with a no-arg constructor and
  every field mutable "because Hibernate needs it". If persistence entities and domain
  aggregates are the same classes, that is a deliberate trade-off — name it and check
  the review is aware, rather than pretending the boundary exists.
- Serialisation concerns: `@JsonProperty`, `@JsonIgnore`, field names chosen for the wire
  format.
- Transport concerns: HTTP status codes, `ResponseEntity`, request/response suffixes.
- Time and randomness taken from static calls (`Instant.now()`, `UUID.randomUUID()`)
  rather than injected, which makes the domain untestable at boundaries and states.
- Anemic aggregates: a domain object with only getters and setters, and all the rules in
  a service. The invariants should be unrepresentable-if-violated, not checked by a
  caller who might forget.

## 3. Transaction boundaries

- Exactly one transaction per use case, opened in the **application** layer. Not in the
  controller (transactions outliving request mapping), not in the repository (one
  transaction per statement, no invariant spans them).
- No remote call inside the transaction. Check `@Transactional` methods for HTTP clients,
  queue publishes and cache calls to another node.
- `readOnly = true` on queries. It is not decoration: it changes flush behaviour and lets
  a replica serve the read.
- Self-invocation: a `@Transactional` method called from another method of the same bean
  is not transactional at all under proxy-based AOP. Look for it explicitly.
- Propagation choices (`REQUIRES_NEW`, `NESTED`) must be justified in a comment; they are
  almost always either a workaround for a boundary in the wrong place, or a deliberate
  and correct choice for an audit write that must survive a rollback.

## 4. Contracts at the edge

- **Contract-first** where the API is public: the OpenAPI document is the source of
  truth, DTOs are generated, and the build fails when the code and the contract diverge.
  Hand-written DTOs alongside a published spec drift within two sprints.
- Generated DTOs must not cross into `application` or `domain`. The mapper belongs in
  `api` (inbound) or `infrastructure` (outbound), converting at the boundary.
- A domain type must never be serialised directly as an API response. The first
  refactoring of a field name then becomes a breaking API change.
- Backward compatibility: does the change remove a field, tighten a type, add a required
  field, or change an enum's meaning? Each breaks a client already deployed.
- Error contract: a single error shape across the API, with a stable machine-readable
  code. Check the new endpoint uses the shared handler rather than inventing a body.

## 5. Enforcement

The finding that matters most in this review is: **nothing prevents the next violation.**

If the project has no architecture test, that is a MAJOR finding on its own, and the fix
is small. `references/archunit-rules.md` contains a ready set of rules for the layout
above, including the ones worth having beyond layering (no `System.out`, no field
injection, no `@Transactional` on controllers, repositories only reachable from
infrastructure).

Check also:
- module boundaries enforced by the build (Maven modules, JPMS, Gradle projects) rather
  than by convention;
- a test that fails when the domain gains a framework dependency, not a rule in a wiki.

## Output format

```
VERDICT: REQUEST CHANGES | APPROVE WITH FOLLOW-UPS | APPROVE

BLOCKER  domain/Payment.java:1  Domain aggregate annotated @Entity
  Consequence: the persistence model now dictates the domain model; every schema
  change becomes a domain change, and the aggregate cannot be unit-tested without a
  persistence context.
  Fix: keep Payment framework-free, add PaymentJpaEntity in infrastructure with a
  mapper; or state explicitly that this project merges the two and drop the pretence.

MAJOR    (project)  No architecture test enforces the layering
  Fix: add the rules in references/archunit-rules.md to the test source set.
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

Two rules for this review specifically:

- **Name the consequence, not the principle.** "This violates hexagonal architecture" is
  not a finding. "A change to the column type will now force a change to the domain API
  used by three call sites" is.
- **Accept deliberate deviations.** A small service that maps entities directly can be
  correct. What is not correct is a codebase that claims one architecture and implements
  another; the review's job is to close that gap in either direction.
