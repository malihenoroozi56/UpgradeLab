import { describe, expect, it } from 'vitest';
import { CONFIG_SCHEMA_VERSION } from '@upgradelab/contracts';

describe('test harness', () => {
  it('resolves workspace packages from TypeScript sources', () => {
    expect(CONFIG_SCHEMA_VERSION).toBe(1);
  });
});
