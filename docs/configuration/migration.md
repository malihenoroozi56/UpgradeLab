# Schema migrations

UpgradeLab has three versioned public surfaces:

| Surface       | Constant                | Current version |
| ------------- | ----------------------- | --------------- |
| Configuration | `CONFIG_SCHEMA_VERSION` | `1`             |
| Report        | `REPORT_SCHEMA_VERSION` | `1`             |
| Plugin API    | `PLUGIN_API_VERSION`    | `1`             |

## Configuration migrations

UpgradeLab refuses a configuration whose `schemaVersion` is not supported and prints a migration hint. It
never silently reinterprets an old document.

### Migrating to version 1

There is no earlier released schema. When a future version is introduced, this page will list:

1. the changed or removed keys;
2. a before/after example;
3. whether the change is mechanical or requires human judgement;
4. the release in which the old version stops being accepted.

### Applying a migration

1. Read the changelog entry for the schema version.
2. Update `schemaVersion` only after updating the document.
3. Run `upgradelab validate`; unknown keys and missing fields are reported with their paths.
4. Run `upgradelab run --scenario <id>` to verify behaviour, not just syntax.

## Report schema migrations

Reports are written with `schemaVersion: 1`. Consumers should:

- reject unknown major versions rather than guessing;
- tolerate added optional fields within the same version;
- treat check ids, evidence ids and JUnit test-case names as stable identifiers.

`upgradelab report` validates a report before re-rendering it, so a future-version report produces a clear
`CONFIG_UNSUPPORTED_VERSION` error instead of a malformed output.

## Plugin API migrations

A plugin declares `apiVersion: 1`. Loading a plugin with a different API version fails with an actionable
error rather than calling functions with an incompatible contract. When the API changes:

1. increment `PLUGIN_API_VERSION`;
2. publish a migration guide and an example diff;
3. keep the previous API loadable for at least one minor release where feasible, or fail loudly with a
   version-specific message.

## Compatibility policy

- Adding optional configuration fields is a minor change.
- Changing verdict semantics, security defaults or required fields is a major change and requires an ADR.
- The CLI, report and plugin versions may advance independently; `upgradelab version` prints all three.
