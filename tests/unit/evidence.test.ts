import { describe, expect, it } from 'vitest';
import { createRedactor } from '@upgradelab/contracts';
import { EvidenceCollector } from '@upgradelab/core';

describe('evidence collection', () => {
  it('redacts evidence before storing it', () => {
    const collector = new EvidenceCollector(createRedactor());
    const reference = collector.add(
      'log',
      'container log',
      'connecting with postgres://user:secret-password@db:5432/app',
    );
    expect(reference.inline).not.toContain('secret-password');
    expect(reference.inline).toContain('[REDACTED]');
    expect(collector.all()).toHaveLength(1);
  });

  it('truncates individual evidence items and records the original size', () => {
    const collector = new EvidenceCollector(createRedactor(), { maxInlineBytes: 20 });
    const reference = collector.add('log', 'big log', 'x'.repeat(200));
    expect(reference.truncated).toBe(true);
    expect(reference.bytes).toBe(200);
    expect((reference.inline ?? '').length).toBeLessThan(100);
    expect(reference.inline).toContain('truncated');
  });

  it('enforces a total evidence budget', () => {
    const collector = new EvidenceCollector(createRedactor(), {
      maxInlineBytes: 50,
      maxTotalBytes: 60,
    });
    collector.add('log', 'first', 'a'.repeat(50));
    const second = collector.add('log', 'second', 'b'.repeat(50));
    expect(second.truncated).toBe(true);
    expect(collector.size).toBe(2);
  });

  it('assigns deterministic, unique ids', () => {
    const collector = new EvidenceCollector(createRedactor());
    const first = collector.add('log', 'a', 'a');
    const second = collector.add('log', 'b', 'b');
    expect(first.id).toBe('ev-1');
    expect(second.id).toBe('ev-2');
  });
});
