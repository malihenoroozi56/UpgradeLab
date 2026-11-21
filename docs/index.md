---
layout: home

hero:
  name: UpgradeLab
  text: Prove upgrades preserve user data
  tagline: Real Docker Compose upgrades, deterministic verdicts, evidence you can attach to a bug report.
  actions:
    - theme: brand
      text: Get started
      link: /getting-started
    - theme: alt
      text: Verdict semantics
      link: /concepts/verdicts

features:
  - title: Deterministic
    details: PASSED, FAILED, INCONCLUSIVE and CANCELLED are computed from checks. AI never decides.
  - title: Data-first
    details: SQL invariants are captured before the upgrade and compared after it, inside read-only transactions.
  - title: Isolated
    details: One generated Compose project per run, loopback-only ports, resource limits, ownership-checked cleanup.
  - title: CI-native
    details: Stable exit codes, JSON/Markdown/JUnit reports and a GitHub Action with no requested permissions.
---

## A container that starts is not proof

```text
source release → seed → baseline → upgrade → verify invariants → PASSED / FAILED / INCONCLUSIVE
```

Most upgrade tests stop at "the new container is healthy". UpgradeLab continues: it captures your data
invariants before the upgrade, applies the real release and migrations, and verifies the same invariants
afterwards. If verification cannot run, the result is `INCONCLUSIVE`, not a pass.

Read [how a run works](/concepts/how-runs-work) and [the verdict rules](/concepts/verdicts).
