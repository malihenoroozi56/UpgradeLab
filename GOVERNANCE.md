# Governance

UpgradeLab is an Apache-2.0 open-source project. This document describes how decisions are made and how
maintainers are added.

## Roles

- **Users** — anyone running UpgradeLab or reporting bugs.
- **Contributors** — anyone who opens an issue, pull request, documentation change or test.
- **Maintainers** — people with merge access who steward the project, review changes and cut releases.
- **Security responders** — maintainers who handle private vulnerability reports.

The initial maintainer is the project author. Additional maintainers are added by consensus of the current
maintainers after sustained, high-quality contributions (code, review or documentation) and agreement to
follow `CODE_OF_CONDUCT.md` and `SECURITY.md`.

## Decision making

- Small changes: pull request review by one maintainer.
- Public API, schema, verdict semantics, security defaults or new runtime dependencies: pull request review
  plus an ADR in `docs/adr/` and a changeset.
- Breaking changes: a major version and a migration note in `docs/configuration/migration.md`.
- Disagreements are resolved by discussion on the issue or pull request. If consensus is not reached,
  maintainers decide by simple majority; the rationale is recorded in the ADR or the pull request.

## Releases

- Releases follow Semantic Versioning.
- User-visible changes require a changeset (`pnpm changeset`).
- The release workflow builds, runs the full test suite and publishes from the versioned tag.
- Security fixes may be released outside the normal cadence.

## Security reports

Private reports follow `SECURITY.md`. Maintainers must not disclose a vulnerability before a fix and a
coordinated disclosure date are agreed with the reporter.

## Areas without a maintainer

If an area loses its maintainer, it is marked as "seeking maintainer" in the README or roadmap. The project
may still accept fixes, but no new features are promised.

## Code of conduct enforcement

Reports of unacceptable behaviour go to the maintainers through a private channel. Maintainers recuse
themselves from cases involving them. Enforcement follows the guidelines in `CODE_OF_CONDUCT.md`.

## Amendments

Changes to this document require a pull request and approval by all active maintainers.
