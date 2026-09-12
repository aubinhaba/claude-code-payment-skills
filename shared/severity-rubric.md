<!--
The one source of the severity rubric. Each review skill embeds the block below verbatim,
so that a skill directory copied on its own still carries it; scripts/validate-pack.js
fails when a copy drifts from this file. The verdict rule that follows the table in each
skill is the skill's own: REQUEST CHANGES for the code reviews, DO NOT APPLY for
aws-change-review. production-readiness decides a release rather than a diff, and maps
these levels to its BLOCKING / BEFORE RELEASE buckets instead of repeating them.
-->

Severity, so that two skills reviewing one diff produce comparable verdicts:

| Level | Threshold |
| :--- | :--- |
| **BLOCKER** | Merging this loses money or data, or produces an audit finding. |
| **MAJOR** | A defect that will surface in production under load or partial failure. |
| **MINOR** | A maintenance cost, or a defect bounded to a single caller. |
| **NOTE** | Something the author should know. No action required. |
