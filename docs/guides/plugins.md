# Plugins

Plugins extend UpgradeLab with assertion types, database adapters, environment providers and report
formats. They are **explicit ES modules**; UpgradeLab never discovers or downloads them.

## Loading

```bash
upgradelab run --plugin ./plugins/my-plugin.mjs
```

Or in configuration (requires opt-in):

```yaml
security:
  allowConfigPlugins: true
plugins:
  - path: ./plugins/my-plugin.mjs
    config:
      threshold: 3
```

Rules:

- the path must end in `.js` or `.mjs` (build TypeScript first);
- the module must export a plugin object as `default` (or named `plugin`);
- it must declare `apiVersion: 1`;
- it must resolve inside the project root unless the loader is explicitly allowed to go outside;
- built-in assertion types and report formats cannot be overridden.

## Plugin shape

```js
export default {
  name: 'my-plugin',
  version: '1.0.0',
  apiVersion: 1,
  description: 'Optional',
  register(registry, config) {
    // register capabilities
  },
};
```

`register` is synchronous. Exceptions abort loading with a `PLUGIN_LOAD_FAILED` error.

## Registering an assertion

```js
registry.registerAssertion({
  type: 'row-count', // lower-case, cannot collide with http/sql/command/container/health
  description: 'Checks a table row count',
  async execute(assertion, context) {
    const { params } = assertion; // custom fields from YAML
    const result = await context.database.execute(`SELECT COUNT(*) FROM ${params.table}`);
    const actual = Number(result.values[0]);
    return {
      passed: actual === params.expected,
      message: `expected ${params.expected}, got ${actual}`,
      expected: params.expected,
      actual,
      evidenceIds: [],
    };
  },
});
```

The context gives read access to the application endpoint, environment, database session and evidence sink.
It is scoped to one check. Plugin assertions receive `params` containing every non-envelope field.

In configuration:

```yaml
assertions:
  - id: users-rows
    type: row-count
    table: users
    expected: 3
```

`validateAssertions` in the assertion engine will call the optional `validate` hook if you register one.

## Registering a database adapter

```js
registry.registerDatabaseAdapter({
  id: 'mysql',
  description: 'MySQL read-only adapter',
  validateReadOnlyQuery(query) {
    /* throw UpgradeLabError(ASSERTION_UNSAFE_QUERY) */
  },
  async connect(target, options) {
    /* return { execute, dispose } */
  },
});
```

Set `environment.database.adapter: mysql` in configuration. The adapter must enforce read-only access at the
database level, not only in text validation.

## Registering an environment provider

Implement the `EnvironmentProvider` contract (preflight, createEnvironment, startService, replaceService,
getServiceState, getEndpoint, waitForReadiness, runCommand, collectLogs, describeEnvironment,
destroyEnvironment) and register it. Set `environment.provider` to its id.

Providers are responsible for isolation, ownership-labelled cleanup and cancellation.

## Registering a report format

```js
registry.registerReporter('csv', {
  fileExtension: 'csv',
  render(report) {
    return 'run_id,scenario_id,status\n' + report.scenarios.map(/* … */).join('\n');
  },
});
```

The report passed to `render` is already redacted; do not attempt to re-read run files. See
[`examples/plugins/csv-reporter`](https://github.com/upgradelab/upgradelab/tree/main/examples/plugins/csv-reporter).

## Security

Plugins run in the UpgradeLab process with the runner's privileges. They can read environment variables,
spawn processes and modify reports (within the redacted input). Treat a plugin like a dependency: pin it,
review it and do not load untrusted paths in CI.

## Testing plugins

Use the plugin loader directly in a Vitest test:

```ts
import { loadPlugins } from '@upgradelab/plugin-sdk';

const result = await loadPlugins([{ path: './tests/fixtures/plugins/valid.mjs' }], {
  logger,
  configDirectory: process.cwd(),
});
```

The repository's contract tests demonstrate loading, reserved-name rejection, API-version checks and path
confinement.
