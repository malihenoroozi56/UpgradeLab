export default {
  name: 'duplicate-plugin',
  version: '1.0.0',
  apiVersion: 1,
  register(registry) {
    registry.registerAssertion({ type: 'http', execute: async () => ({ passed: true }) });
  },
};
