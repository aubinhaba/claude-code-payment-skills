# PCI scope — questions per component

The goal of a scope review is not to prove compliance. It is to keep the number of
components that touch cardholder data as small as the business allows, because every
component inside the Cardholder Data Environment (CDE) costs audit effort, hardening,
segmentation and logging discipline for as long as it exists.

A change that adds one service to the CDE is cheap to write and expensive forever.
That asymmetry is the reason this review exists.

## Vocabulary, precisely

| Term | Meaning | Storable after authorization |
| :--- | :--- | :--- |
| PAN | Primary Account Number, the card number | Only if encrypted, with a retention window |
| CVV / CVC / CID | The verification value | **Never**, under any condition |
| Track data / chip data | Full magnetic stripe or EMV data | **Never** |
| PIN / PIN block | Cardholder PIN | **Never** |
| Expiry, cardholder name | Cardholder data when stored with the PAN | Yes, but they inherit the PAN's protection |
| Token | A surrogate with no exploitable value outside the vault | Yes — that is the point |
| Truncated PAN | First six and last four as the baseline; for a 16-digit PAN, at most the first eight and any other four (PCI SSC FAQ 1091) | Yes |

"Never" means never: not encrypted, not for three seconds, not in memory beyond the
authorization call, not in a retry buffer, not in a support ticket, not in an outbox
row, not in a Kafka message that a compacted topic will keep.

## Per-component questions

### A new HTTP endpoint
- Does the request body accept a PAN? If yes, does the endpoint belong to the small set
  of card-facing components, and is it network-segmented from the rest?
- Could the client send a PAN in a field typed as free text (a `reference`, a `note`, a
  `metadata` map)? Free-text passthrough fields are how PANs end up in the CRM. Either
  reject card-like input or state why the risk is accepted.
- Is the endpoint behind the same ALB/ingress as non-CDE services, sharing access logs
  that record query strings?

### A new queue message or event
- Does the payload carry card data? Queues persist, replay, dead-letter and get dumped
  into a debugging bucket during an incident.
- Does the consumer live in the CDE? If not, the message must carry a token.
- Is the topic compacted or long-retention? Then "transient" is not true.

### A new cache entry
- Card data in Redis/ElastiCache means the cache node, its snapshots, its backups and
  anyone with `KEYS *` access are in scope. Use the token as the key, never the PAN,
  and never the PAN as part of a composite key: keys turn up in slow-log and in metrics.

### A new database column
- Is the column in a schema already in scope? Adding `pan_encrypted` to a table that
  three non-CDE services read is a scope extension even if the value is encrypted,
  because those services now hold ciphertext and the audit follows the data.
- Where is the key? A key stored next to the data is not encryption, it is obfuscation.
- Who can `SELECT *`? Analytics replicas, BI exports and CDC pipelines are the usual
  silent path out of the CDE.

### A new third-party SDK or dependency in a card-facing component
- The SDK runs in the same process as the PAN. It can read it. Any telemetry, crash
  reporter or "anonymous usage statistics" the SDK ships with is an exfiltration path.
- On the browser side, any script on the card-entry page is in scope. That is the whole
  argument for the iframe: it reduces the page's script surface to code you control.

### A new log statement, dashboard or alert
- Does it template an object that may contain card fields? Check the object's
  `toString`, its Jackson serialisation, and whether a future field could be added
  without the mask following it.
- Alerts often bypass the masking layer because they format the payload themselves.

## The traps

**"It's only for support."** A support tool that displays full PANs is a CDE component
with the widest human access in the company. Display the mask; if support needs to
match a card, match on the token or on first-six + last-four.

**"It's only in the non-prod environment."** Non-prod with production card data is
production. Either the data is synthetic or the environment is in scope.

**"It's encrypted at rest."** At-rest encryption protects against a stolen disk. It does
not remove the component from scope, and it does nothing against an application-level
leak, which is the leak that actually happens.

**"The PSP handles PCI for us."** The PSP handles their side. If your code touches the
PAN before handing it over, your side is in scope. The way to make that sentence true
is to never touch the PAN — hosted fields, iframe, or a client-side tokenization SDK
that posts directly to the PSP.

**"We'll strip it before storing."** Order of operations decides. Strip before the
object reaches the persistence layer, not in a `@PrePersist`, not in an interceptor
that a future code path bypasses.

## Reducing scope — the moves that work

1. **Tokenize at the edge.** The card never reaches your backend. The browser posts to
   the PSP or vault, gets a token, and your API receives the token. This is the single
   biggest scope reduction available.
2. **Isolate card entry in an iframe** served from a dedicated origin, with a strict CSP
   and no third-party scripts. The parent page — the part your product teams change
   weekly — stays out of scope.
3. **One vault component.** Exactly one service exchanges card data for tokens. Its
   API accepts card data; nothing else does. It is small, rarely changed, and separately
   deployed.
4. **Network segmentation that is real**, meaning security groups and subnets, not a
   naming convention.
5. **Mask in the serialiser**, so that scope violations require deliberate effort rather
   than a moment of forgetfulness.

## Evidence a reviewer can ask for

- The list of components that receive card data, before and after the change.
- The `postMessage` origin allowlist, as code.
- The masking converter, and a test proving a new card-carrying DTO is masked.
- A test asserting the CVV is absent from the persisted payload and from the outbox row.
- The retention job for stored PANs, with its schedule and its last successful run.
