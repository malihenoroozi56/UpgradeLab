export default {
  name: 'throwing-plugin',
  version: '1.0.0',
  apiVersion: 1,
  register() {
    throw new Error('registration exploded');
  },
};
