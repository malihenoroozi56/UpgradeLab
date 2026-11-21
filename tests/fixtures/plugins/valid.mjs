/** Fixture plugin used by the plugin contract tests. */
export const name = 'fixture-plugin';
export const version = '1.2.3';
export const apiVersion = 1;

export function register(registry) {
  registry.registerAssertion({
    type: 'fixture-check',
    async execute() {
      return { passed: true, message: 'fixture assertion executed' };
    },
  });
  registry.registerReporter('fixture-text', {
    fileExtension: 'txt',
    render(report) {
      return `fixture:${report.run.status}\n`;
    },
  });
}

export default { name, version, apiVersion, register };
