export default {
  name: 'double-load-plugin',
  version: '1.0.0',
  apiVersion: 1,
  register(registry) {
    registry.registerReporter('double-load', { fileExtension: 'txt', render: () => 'x' });
  },
};
