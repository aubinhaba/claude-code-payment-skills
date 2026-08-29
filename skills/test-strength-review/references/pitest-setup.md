# Mutation testing that a team will keep running

The reason mutation testing gets abandoned is runtime. A full run on a large module is
minutes to hours, and a gate that slow gets disabled during the first urgent release.
The configuration below keeps it under a few minutes by scoping it, and runs the full
sweep on a schedule instead.

## Maven

```xml
<plugin>
  <groupId>org.pitest</groupId>
  <artifactId>pitest-maven</artifactId>
  <version>1.17.0</version>
  <dependencies>
    <dependency>
      <groupId>org.pitest</groupId>
      <artifactId>pitest-junit5-plugin</artifactId>
      <version>1.2.1</version>
    </dependency>
  </dependencies>
  <configuration>
    <!-- Scope: the code where a silent wrong answer costs money. -->
    <targetClasses>
      <param>com.example.payments.domain.*</param>
      <param>com.example.payments.application.*</param>
    </targetClasses>
    <targetTests>
      <param>com.example.payments.*Test</param>
    </targetTests>

    <!-- Exclusions: generated code and wiring. Mutating these buys nothing. -->
    <excludedClasses>
      <param>com.example.payments.api.dto.*</param>
      <param>*MapperImpl</param>
      <param>*Configuration</param>
      <param>*Application</param>
    </excludedClasses>
    <avoidCallsTo>
      <avoidCallsTo>org.slf4j</avoidCallsTo>
      <avoidCallsTo>java.util.logging</avoidCallsTo>
    </avoidCallsTo>

    <!-- DEFAULTS plus the operators that catch real payment defects. -->
    <mutators>
      <mutator>DEFAULTS</mutator>
      <mutator>REMOVE_CONDITIONALS</mutator>
      <mutator>EXPERIMENTAL_BIG_INTEGER</mutator>
    </mutators>

    <mutationThreshold>85</mutationThreshold>
    <coverageThreshold>80</coverageThreshold>
    <testStrengthThreshold>90</testStrengthThreshold>

    <timestampedReports>false</timestampedReports>
    <outputFormats>
      <outputFormat>HTML</outputFormat>
      <outputFormat>XML</outputFormat>
    </outputFormats>
    <threads>4</threads>
  </configuration>
</plugin>
```

`EXPERIMENTAL_BIG_INTEGER` mutates `BigInteger` **and** `BigDecimal` operations — `add`
to `subtract`, scale and rounding changes. On a money codebase it is the highest-value
mutator available and it is off by default. The name says INTEGER; the coverage includes
`BigDecimal`, which is why it is easy to go looking for a `BIG_DECIMAL` operator that
does not exist. An unknown operator name fails PIT at startup, before a single mutant is
generated — check the operator list of your PIT version if the build stops there.

## The three numbers, and which one to argue about

| Metric | Definition | What a low value means |
| :--- | :--- | :--- |
| Line coverage | Lines executed by tests | Code paths never run at all |
| **Mutation coverage** | Mutants killed ÷ all mutants | Behaviour that could change unnoticed |
| **Test strength** | Mutants killed ÷ mutants **covered** by a test | Tests run the code but assert nothing useful |

Test strength is the one that exposes assertion theatre: it removes the excuse of
untested code and measures only the code the tests do touch. A module at 60% coverage and
95% test strength has a gap in *scope*. A module at 90% coverage and 55% test strength
has a gap in *rigour*, and only the second is a review finding about the tests
themselves.

## Incremental analysis for merge requests

Full run nightly; changed-code run on every merge request.

```xml
<configuration>
  <withHistory>true</withHistory>
  <historyInputFile>${project.build.directory}/pit-history/history.bin</historyInputFile>
  <historyOutputFile>${project.build.directory}/pit-history/history.bin</historyOutputFile>
</configuration>
```

With the history file cached between runs, PIT re-tests only what changed. Cache
`target/pit-history/` in CI and the merge-request run stays in the same order of
magnitude as the unit test phase.

For a change-scoped run without history, `pitest-git` / `scmMutationCoverage` limits the
analysis to modified files:

```bash
mvn -DwithHistory test-compile org.pitest:pitest-maven:scmMutationCoverage \
    -Dinclude=ADDED,MODIFIED \
    -DmutationThreshold=85
```

`test-compile` is not optional. Invoking a plugin goal directly runs no lifecycle phase,
so on a clean CI checkout there is no `target/classes` for PIT to mutate and the run
fails having tested nothing. Confirm the property name for `-Dinclude` against the PIT
version you pin; the SCM goal has changed it before.

## GitLab CI

```yaml
mutation-test:
  stage: test
  script:
    - mvn -B -DwithHistory test-compile org.pitest:pitest-maven:scmMutationCoverage
        -Dinclude=ADDED,MODIFIED -DmutationThreshold=85 -DtestStrengthThreshold=90
  cache:
    key: "pit-$CI_COMMIT_REF_SLUG"
    paths: [ target/pit-history/ ]
  artifacts:
    when: always
    paths: [ target/pit-reports/ ]
    expire_in: 1 week
  rules:
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"

mutation-test-full:
  extends: mutation-test
  script:
    - mvn -B test org.pitest:pitest-maven:mutationCoverage -DmutationThreshold=85
  rules:
    - if: $CI_PIPELINE_SOURCE == "schedule"
```

## Reading a report like a reviewer

Open the HTML report and go to the surviving mutants in the changed classes. For each,
answer one question: **which test should have failed?**

Three outcomes:

1. **A missing test.** The most common, and the useful one. Write it.
2. **An equivalent mutant** — the mutation does not change observable behaviour (a
   changed log level, an unreachable branch, a redundant boundary). Suppress it
   narrowly, with a comment giving the reason. Suppressing by widening an exclusion
   pattern silently removes real coverage as the class grows.
3. **Dead code.** The mutation cannot be observed because the code cannot be reached.
   Delete it. This is mutation testing's quiet second use.

## Adopting on an existing codebase

Do not open with a 90% gate. Nobody will get past it in the current sprint and the
plugin will be commented out by Thursday.

1. Run it once, unthresholded. Record the number.
2. Set the threshold at the current value, rounded down. The build now fails only on
   regression.
3. Raise it as part of work already touching the code. A ratchet that moves is worth
   more than a target that is ignored.
4. Only then argue about which packages deserve a higher bar.

## Cost, stated honestly

Mutation testing multiplies test execution. It is worth its runtime in the domain, the
money arithmetic and the state machines — code where a wrong answer is silent and
expensive. It is not worth it on controllers, adapters, DTOs or configuration, and
running it there is what makes people conclude the technique is impractical.
