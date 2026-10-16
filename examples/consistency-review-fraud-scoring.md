# A real review: a fraud-scoring call added to a payment service

One unedited run of `consistency-review`. The diff below was reviewed, and what follows
it is the output, copied verbatim.

**This diff was written to isolate a defect that does not live in the diff.** Everything a
reader can see in the change is deliberately correct: the configuration key exists, the
HTTP client has a connect timeout and the request has its own, the card hash travels in the
body rather than the URL, the status code is checked and the score range validated, retries
are bounded with exponential backoff and jitter, 4xx is not retried, an interrupt stops the
loop and restores the flag, and failure returns an empty `Optional` — an unknown score,
never a low one. The new tests mock the port and cover both paths.

The problem is two files away.

## What was reviewed

The service is [`aubinhaba/payment-intelligence-agent`](https://github.com/aubinhaba/payment-intelligence-agent)
at commit `42186ee` — MIT, Java 21, Spring Boot, hexagonal, on AWS. The change adds a
fraud-scoring step to transaction ingestion: an outbound port, an HTTP adapter, the call
inside the ingestion use case, the Spring wiring, the configuration key, and two tests.
Six files, 194 added lines.

## How the review ran

Claude Code 2.1.301, model `claude-sonnet-5`, through `claude -p` with
`Read, Grep, Glob, Skill, Task, Bash, ReportFindings` available. One run, 0.296 USD and
60 seconds. It opened `SqsPaymentEventListener`, `DynamoDbTransactionRepository` and
`OutboxEventPublisher` — none of which the diff touches.

**The same diff was also reviewed twice by the code review built into Claude Code.**
Neither run named the duplicate-delivery finding, and neither opened
`SqsPaymentEventListener`. Both runs are kept alongside this one; they each reported
findings of their own on the code inside the diff.

Two things to be exact about, because they change how much this proves:

- **The remaining defect was left in deliberately.** The diff was built for this example,
  on real code, to see whether a review would reach past it.
- **The skills were loaded as project skills** (`.claude/skills/`) rather than as the
  installed plugin. The `SKILL.md` content is identical either way, but the guard hooks
  were not active during this run.

The output is kept inside a code block so it stays byte-for-byte what the run produced.
The scenario table at the end renders as a table once pasted into a pull request, which is
what it is for.

## The diff

<details>
<summary>Six files, 194 added lines — expand</summary>

```diff
diff --git a/pia-application/src/main/java/com/aubin/pia/application/port/out/FraudScoringPort.java b/pia-application/src/main/java/com/aubin/pia/application/port/out/FraudScoringPort.java
new file mode 100644
index 0000000..7fe9883
--- /dev/null
+++ b/pia-application/src/main/java/com/aubin/pia/application/port/out/FraudScoringPort.java
@@ -0,0 +1,15 @@
+package com.aubin.pia.application.port.out;
+
+import java.util.Optional;
+
+/** Remote risk scoring provided by the PSP. */
+public interface FraudScoringPort {
+
+    /**
+     * Risk score between 0 (no risk) and 100 (certain fraud).
+     *
+     * <p>Empty means the provider could not be reached, or answered something unusable.
+     * An unknown score is not a low score; callers must keep the two apart.
+     */
+    Optional<Integer> score(String transactionId, String cardHash);
+}
diff --git a/pia-application/src/main/java/com/aubin/pia/application/usecase/IngestTransactionUseCase.java b/pia-application/src/main/java/com/aubin/pia/application/usecase/IngestTransactionUseCase.java
index 1c9bb68..41f0f9f 100644
--- a/pia-application/src/main/java/com/aubin/pia/application/usecase/IngestTransactionUseCase.java
+++ b/pia-application/src/main/java/com/aubin/pia/application/usecase/IngestTransactionUseCase.java
@@ -1,10 +1,13 @@
 package com.aubin.pia.application.usecase;
 
+import java.util.Optional;
+
 import org.slf4j.Logger;
 import org.slf4j.LoggerFactory;
 
 import com.aubin.pia.application.port.in.IngestTransactionCommand;
 import com.aubin.pia.application.port.out.EventPublisher;
+import com.aubin.pia.application.port.out.FraudScoringPort;
 import com.aubin.pia.application.port.out.MetricsPublisher;
 import com.aubin.pia.application.port.out.TransactionRepository;
 import com.aubin.pia.domain.transaction.Amount;
@@ -21,14 +24,17 @@ public class IngestTransactionUseCase {
     private final TransactionRepository transactionRepository;
     private final EventPublisher eventPublisher;
     private final MetricsPublisher metricsPublisher;
+    private final FraudScoringPort fraudScoringPort;
 
     public IngestTransactionUseCase(
             TransactionRepository transactionRepository,
             EventPublisher eventPublisher,
-            MetricsPublisher metricsPublisher) {
+            MetricsPublisher metricsPublisher,
+            FraudScoringPort fraudScoringPort) {
         this.transactionRepository = transactionRepository;
         this.eventPublisher = eventPublisher;
         this.metricsPublisher = metricsPublisher;
+        this.fraudScoringPort = fraudScoringPort;
     }
 
     public Transaction ingest(IngestTransactionCommand command) {
@@ -39,6 +45,11 @@ public class IngestTransactionUseCase {
                 command.currency(),
                 command.merchantId());
 
+        // Empty means the provider could not be reached. That is an unknown score, not a
+        // low one, and the two must not collapse into the same number downstream.
+        Optional<Integer> riskScore =
+                fraudScoringPort.score(command.transactionId(), command.cardHash());
+
         Transaction transaction =
                 Transaction.create(
                         new TransactionId(command.transactionId()),
@@ -54,7 +65,10 @@ public class IngestTransactionUseCase {
         eventPublisher.publishAll(transaction.pullDomainEvents());
         metricsPublisher.incrementTransactionsIngested();
 
-        log.info("ingest.done txId={}", command.transactionId());
+        log.info(
+                "ingest.done txId={} riskScore={}",
+                command.transactionId(),
+                riskScore.map(String::valueOf).orElse("UNKNOWN"));
         return transaction;
     }
 }
diff --git a/pia-application/src/test/java/com/aubin/pia/application/usecase/IngestTransactionUseCaseTest.java b/pia-application/src/test/java/com/aubin/pia/application/usecase/IngestTransactionUseCaseTest.java
index f77f187..19636da 100644
--- a/pia-application/src/test/java/com/aubin/pia/application/usecase/IngestTransactionUseCaseTest.java
+++ b/pia-application/src/test/java/com/aubin/pia/application/usecase/IngestTransactionUseCaseTest.java
@@ -4,9 +4,11 @@ import static org.assertj.core.api.Assertions.assertThat;
 import static org.assertj.core.api.Assertions.assertThatThrownBy;
 import static org.mockito.ArgumentMatchers.any;
 import static org.mockito.Mockito.verify;
+import static org.mockito.Mockito.when;
 
 import java.math.BigDecimal;
 import java.time.Instant;
+import java.util.Optional;
 
 import org.junit.jupiter.api.Test;
 import org.junit.jupiter.api.extension.ExtendWith;
@@ -16,6 +18,7 @@ import org.mockito.junit.jupiter.MockitoExtension;
 
 import com.aubin.pia.application.port.in.IngestTransactionCommand;
 import com.aubin.pia.application.port.out.EventPublisher;
+import com.aubin.pia.application.port.out.FraudScoringPort;
 import com.aubin.pia.application.port.out.MetricsPublisher;
 import com.aubin.pia.application.port.out.TransactionRepository;
 import com.aubin.pia.domain.transaction.Transaction;
@@ -27,6 +30,7 @@ class IngestTransactionUseCaseTest {
     @Mock TransactionRepository transactionRepository;
     @Mock EventPublisher eventPublisher;
     @Mock MetricsPublisher metricsPublisher;
+    @Mock FraudScoringPort fraudScoringPort;
 
     @InjectMocks IngestTransactionUseCase useCase;
 
@@ -62,6 +66,20 @@ class IngestTransactionUseCaseTest {
         verify(metricsPublisher).incrementTransactionsIngested();
     }
 
+    @Test
+    void should_ingest_when_the_scorer_answers() {
+        when(fraudScoringPort.score("tx_001", "sha256hash")).thenReturn(Optional.of(12));
+        useCase.ingest(validCommand());
+        verify(transactionRepository).save(any(Transaction.class));
+    }
+
+    @Test
+    void should_ingest_when_the_score_is_unknown() {
+        when(fraudScoringPort.score("tx_001", "sha256hash")).thenReturn(Optional.empty());
+        useCase.ingest(validCommand());
+        verify(transactionRepository).save(any(Transaction.class));
+    }
+
     @Test
     void should_return_transaction_with_correct_status() {
         Transaction result = useCase.ingest(validCommand());
diff --git a/pia-bootstrap/src/main/java/com/aubin/pia/config/UseCaseConfig.java b/pia-bootstrap/src/main/java/com/aubin/pia/config/UseCaseConfig.java
index 2a2278c..fa4a04b 100644
--- a/pia-bootstrap/src/main/java/com/aubin/pia/config/UseCaseConfig.java
+++ b/pia-bootstrap/src/main/java/com/aubin/pia/config/UseCaseConfig.java
@@ -17,6 +17,7 @@ import com.aubin.pia.application.policy.VelocityDetectionPolicy;
 import com.aubin.pia.application.port.out.AgentPort;
 import com.aubin.pia.application.port.out.AnomalyRepository;
 import com.aubin.pia.application.port.out.EventPublisher;
+import com.aubin.pia.application.port.out.FraudScoringPort;
 import com.aubin.pia.application.port.out.MetricsPublisher;
 import com.aubin.pia.application.port.out.ReportRepository;
 import com.aubin.pia.application.port.out.ReportStorage;
@@ -46,9 +47,10 @@ public class UseCaseConfig {
     public IngestTransactionUseCase ingestTransactionUseCase(
             TransactionRepository transactionRepository,
             EventPublisher eventPublisher,
-            MetricsPublisher metricsPublisher) {
+            MetricsPublisher metricsPublisher,
+            FraudScoringPort fraudScoringPort) {
         return new IngestTransactionUseCase(
-                transactionRepository, eventPublisher, metricsPublisher);
+                transactionRepository, eventPublisher, metricsPublisher, fraudScoringPort);
     }
 
     @Bean
diff --git a/pia-bootstrap/src/main/resources/application.yml b/pia-bootstrap/src/main/resources/application.yml
index d5ced2f..28dbfed 100644
--- a/pia-bootstrap/src/main/resources/application.yml
+++ b/pia-bootstrap/src/main/resources/application.yml
@@ -59,6 +59,9 @@ pia:
     claude-api-key-path: ${pia.ssm.path-prefix}/claude/api-key
   outbox:
     poll-interval-ms: 5000
+  scoring:
+    base-url: ${PIA_SCORING_BASE_URL:http://localhost:8081}
+    timeout-ms: ${PIA_SCORING_TIMEOUT_MS:2000}
   claude:
     api-key: placeholder   # overridden in application-local.yml or via SsmSecretsLoader (EnvironmentPostProcessor)
     base-url: https://api.anthropic.com
diff --git a/pia-infrastructure/src/main/java/com/aubin/pia/infrastructure/scoring/HttpFraudScoringAdapter.java b/pia-infrastructure/src/main/java/com/aubin/pia/infrastructure/scoring/HttpFraudScoringAdapter.java
new file mode 100644
index 0000000..9525304
--- /dev/null
+++ b/pia-infrastructure/src/main/java/com/aubin/pia/infrastructure/scoring/HttpFraudScoringAdapter.java
@@ -0,0 +1,138 @@
+package com.aubin.pia.infrastructure.scoring;
+
+import java.io.IOException;
+import java.net.URI;
+import java.net.http.HttpClient;
+import java.net.http.HttpRequest;
+import java.net.http.HttpResponse;
+import java.time.Duration;
+import java.util.Optional;
+import java.util.concurrent.ThreadLocalRandom;
+
+import org.slf4j.Logger;
+import org.slf4j.LoggerFactory;
+import org.springframework.beans.factory.annotation.Value;
+import org.springframework.stereotype.Component;
+
+import com.fasterxml.jackson.databind.ObjectMapper;
+import com.fasterxml.jackson.databind.node.ObjectNode;
+
+import com.aubin.pia.application.port.out.FraudScoringPort;
+
+@Component
+public class HttpFraudScoringAdapter implements FraudScoringPort {
+
+    private static final Logger log = LoggerFactory.getLogger(HttpFraudScoringAdapter.class);
+
+    private static final int ATTEMPTS = 3;
+    private static final Duration INITIAL_BACKOFF = Duration.ofMillis(200);
+    private static final int MIN_SCORE = 0;
+    private static final int MAX_SCORE = 100;
+
+    private final HttpClient httpClient;
+    private final ObjectMapper objectMapper;
+    private final URI endpoint;
+    private final Duration requestTimeout;
+
+    @SuppressWarnings({"EI_EXPOSE_REP2"}) // ObjectMapper is a thread-safe singleton
+    public HttpFraudScoringAdapter(
+            @Value("${pia.scoring.base-url}") String baseUrl,
+            @Value("${pia.scoring.timeout-ms}") long timeoutMs,
+            ObjectMapper objectMapper) {
+        this.endpoint = URI.create(baseUrl + "/score");
+        this.requestTimeout = Duration.ofMillis(timeoutMs);
+        this.objectMapper = objectMapper;
+        this.httpClient =
+                HttpClient.newBuilder().connectTimeout(Duration.ofMillis(timeoutMs)).build();
+    }
+
+    @Override
+    public Optional<Integer> score(String transactionId, String cardHash) {
+        Duration backoff = INITIAL_BACKOFF;
+        for (int attempt = 1; attempt <= ATTEMPTS; attempt++) {
+            try {
+                return Optional.of(parse(send(transactionId, cardHash)));
+            } catch (ScoringFailure ex) {
+                log.warn(
+                        "scoring.attempt.failed txId={} attempt={} retryable={} reason={}",
+                        transactionId,
+                        attempt,
+                        ex.retryable(),
+                        ex.getMessage());
+                if (!ex.retryable() || attempt == ATTEMPTS || !backOff(backoff)) {
+                    break;
+                }
+                backoff = backoff.multipliedBy(2);
+            }
+        }
+        return Optional.empty();
+    }
+
+    /** The card hash travels in the body: a query string lands in access logs and traces. */
+    private HttpResponse<String> send(String transactionId, String cardHash) {
+        ObjectNode body = objectMapper.createObjectNode();
+        body.put("transactionId", transactionId);
+        body.put("cardHash", cardHash);
+
+        HttpRequest request =
+                HttpRequest.newBuilder(endpoint)
+                        .timeout(requestTimeout)
+                        .header("Content-Type", "application/json")
+                        .POST(HttpRequest.BodyPublishers.ofString(body.toString()))
+                        .build();
+        try {
+            return httpClient.send(request, HttpResponse.BodyHandlers.ofString());
+        } catch (IOException ex) {
+            throw new ScoringFailure("transport: " + ex.getMessage(), true);
+        } catch (InterruptedException ex) {
+            Thread.currentThread().interrupt();
+            throw new ScoringFailure("interrupted", false);
+        }
+    }
+
+    private int parse(HttpResponse<String> response) {
+        int status = response.statusCode();
+        if (status >= 500) {
+            throw new ScoringFailure("status " + status, true);
+        }
+        if (status != 200) {
+            throw new ScoringFailure("status " + status, false);
+        }
+        int score;
+        try {
+            score = Integer.parseInt(response.body().trim());
+        } catch (NumberFormatException ex) {
+            throw new ScoringFailure("body is not a score", false);
+        }
+        if (score < MIN_SCORE || score > MAX_SCORE) {
+            throw new ScoringFailure("score out of range: " + score, false);
+        }
+        return score;
+    }
+
+    /** False when the wait was interrupted, so the caller stops instead of retrying. */
+    private boolean backOff(Duration backoff) {
+        long jitter = ThreadLocalRandom.current().nextLong(backoff.toMillis() / 2 + 1);
+        try {
+            Thread.sleep(backoff.toMillis() + jitter);
+            return true;
+        } catch (InterruptedException ex) {
+            Thread.currentThread().interrupt();
+            return false;
+        }
+    }
+
+    private static final class ScoringFailure extends RuntimeException {
+        private static final long serialVersionUID = 1L;
+        private final transient boolean retryable;
+
+        ScoringFailure(String message, boolean retryable) {
+            super(message);
+            this.retryable = retryable;
+        }
+
+        boolean retryable() {
+            return retryable;
+        }
+    }
+}
```

</details>

## The review, verbatim

```
VERDICT: REQUEST CHANGES

There is no BLOCKER. The diff doesn't lose money or data. It has three MAJOR findings with no owner or date, and the skill only allows "approve with follow-ups" when each MAJOR has both.

**MAJOR** `application.yml:63-64` Default hides a missing production setting
- Interleaving: the keys exist only in `application.yml`, with `${PIA_SCORING_BASE_URL:http://localhost:8081}`. `application-dev.yml` and `application-prod.yml` don't set them. Prod deploys without the env var and starts normally, because the default fills the gap. Every call then hits `localhost:8081` and gets connection refused. Each ingest spends about 0.9 s in backoff and logs a warning, then reports `UNKNOWN`. Nothing fails, so nobody notices.
- Fix: remove the default for `base-url` so a missing value stops startup, or set it explicitly in `application-prod.yml` and `application-dev.yml`. Also confirm `PIA_SCORING_*` is wired in the deploy config. I found no Terraform or task definition in the repo.

**MAJOR** `IngestTransactionUseCase.java:50`, `HttpFraudScoringAdapter.java:46-62` Remote call with retries sits between the duplicate check and the save
- Interleaving:
  1. The SQS message is delivered and `findById` finds nothing.
  2. `score()` runs. The worst case is about 3 × 2 s requests plus 0.6–0.9 s of backoff, so roughly 7 s or more.
  3. The visibility timeout expires, or a second consumer receives the same message, and its `findById` also finds nothing.
  4. Both reach `save`. This is an unconditional `putItem` (`DynamoDbTransactionRepository.java:52`), so the second write overwrites the first.
  5. Both write an outbox row (`OutboxEventPublisher.java:71`), so the event is published twice.
- The check-then-act race and the save/outbox gap were already there. This diff widens the race window from milliseconds to seconds.
- Fix:
  - Make `save` conditional with `attribute_not_exists`, and treat the conditional-check failure as a duplicate no-op.
  - Move scoring after the save, or off the hot path.
  - Check that the queue's visibility timeout is longer than the worst-case scoring time. I couldn't see the queue config.

**MAJOR** `IngestTransactionUseCase.java:50-70` The unknown score is never recorded or resolved
- Interleaving: the provider times out, so `riskScore` is empty. The transaction is saved without a score. The only trace is the `riskScore=UNKNOWN` log line. No state records "unscored" and nothing rescoring it later. The comment says unknown and low must stay apart downstream, but nothing is downstream. A transaction that scored 95 and one that timed out both leave the use case with no score attached.
- So the change adds an outage dependency and about 7 s of latency for a value that is discarded.
- Fix: persist the score or an explicit `UNSCORED` state on the transaction. Add a bounded re-score job, with an age alert on `UNSCORED` older than N minutes. If this is a stepping-stone commit, say so in the PR and give the follow-up an owner.

**MINOR** `HttpFraudScoringAdapter.java:81` Retried POST without an idempotency key
- Scoring is read-like, so retrying is acceptable. If the provider records velocity or counts per call by `cardHash`, a retry after a timeout counts twice.
- Fix: send `Idempotency-Key: <transactionId>` on every attempt, or confirm the provider ignores repeats.

**MINOR** `HttpFraudScoringAdapter.java:84` The timeout may not cover the response body
- The JDK `HttpRequest.timeout` bounds the wait for response headers. A provider that sends headers and then stalls the body can hold the listener thread past 2 s. I haven't verified this against the JDK version in use.
- Fix: run the call under a hard deadline, such as a `CompletableFuture.orTimeout` on `sendAsync`.

**MINOR** `HttpFraudScoringAdapter.java:22` No circuit breaker
- If the provider is slow rather than down, every message holds a listener thread for about 7 s. Consumer throughput drops to a fraction and the queue backs up.
- Fix: add a breaker whose fallback is the defined `Optional.empty()`.

**NOTE** The retry policy itself is sound. It is bounded at 3 attempts, exponential with jitter, only 5xx and transport errors are retried, 4xx and bad bodies fail fast, and interrupts stop the loop. The card hash goes in the body, not the URL. The scoring call is not inside a transaction.

**NOTE** The tests only assert that ingest still saves. Nothing covers the adapter's retry or timeout behaviour. A WireMock test for 503, 503, 200 and for a read timeout would pin it down.

| # | Failure | Expected behaviour | Mechanism | Present? |
| :-- | :--- | :--- | :--- | :--- |
| S1 | SQS message delivered twice, including concurrently | Second is a no-op | `findById` check only; unconditional `putItem` | **no — MAJOR** (window widened) |
| S2 | Scoring call times out | Unknown recorded and resolved later | `Optional.empty()`, then log only | **partial — MAJOR** |
| S3 | Scoring succeeds but the response is lost | Retry is harmless | Retry, no idempotency key | partial — MINOR |
| S4 | 5xx or connection refused | Bounded backoff retry | 3 attempts, exponential with jitter | yes |
| S5 | 4xx, bad body, or score out of range | No retry, fail closed to unknown | `retryable=false` | yes |
| S6 | Provider slow, not down | Calls shed before the listener pool is exhausted | Circuit breaker | **no — MINOR** |
| S7 | Prod runs without `PIA_SCORING_BASE_URL` | Startup fails | Default to `localhost:8081` | **no — MAJOR** |
| S8 | Crash after `save`, before `publishAll` | Event eventually published | Separate `putItem` calls, not one transaction | no — pre-existing, outside this diff |
| S9 | Provider unreachable for hours | Detected and reconciled | None | no — covered by the MAJOR on unresolved unknowns |

NOT REVIEWED: queue visibility timeout, DLQ and redrive config (not in the repo); `SqsPaymentEventListenerTest` and the other infrastructure tests; the `DetectAnomaliesUseCase` path after ingest; `OutboxEventPublisher`'s relay side (I only read the write).
```
