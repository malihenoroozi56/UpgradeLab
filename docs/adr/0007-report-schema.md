# ADR 0007 — Versioned report with a single redaction pass

**Status:** Accepted

## Context

Reports are shared as CI artifacts and attached to issues. Different formats must not disagree, and a
plugin reporter must not be able to leak data that built-in reporters redact.

## Decision

`buildReportDocument` produces a JSON document with `schemaVersion: 1`. `writeReports` redacts it once with
the configured redactor, then renders every requested format from the redacted object. Reporters receive
only redacted data. Check ids, evidence ids (`ev-N`) and JUnit test-case names are stable.

## Consequences

- JSON, Markdown and JUnit cannot disagree about redaction.
- Plugin reporters inherit the same protection.
- Changing the document shape requires a schema version bump and an ADR.
