import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  ReporterRegistry,
  jsonReporter,
  junitReporter,
  markdownReporter,
  writeReports,
} from '@upgradelab/reporters';
import { createRedactor, type Reporter, type StructuredLogger } from '@upgradelab/contracts';
import { sampleReport, sampleScenario } from '../helpers/report.js';

const temporaryDirectories: string[] = [];

afterAll(async () => {
  await Promise.all(
    temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const logger: StructuredLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => logger,
};

/** Minimal well-formedness check for the subset of XML the reporter emits. */
function expectWellFormedXml(xml: string): void {
  const tokens = xml.match(/<[^>]*>/g) ?? [];
  const stack: string[] = [];
  for (const token of tokens) {
    if (token.startsWith('<?') || token.startsWith('<!')) {
      continue;
    }
    const closing = /^<\/([A-Za-z0-9:_-]+)>$/.exec(token);
    if (closing) {
      const expected = stack.pop();
      expect(closing[1]).toBe(expected);
      continue;
    }
    const selfClosing = /^<([A-Za-z0-9:_-]+)(\s[^>]*)?\/>$/.exec(token);
    if (selfClosing) {
      continue;
    }
    const opening = /^<([A-Za-z0-9:_-]+)(\s[^>]*)?>$/.exec(token);
    if (opening) {
      stack.push(opening[1] ?? '');
      continue;
    }
    throw new Error(`unexpected XML token: ${token}`);
  }
  expect(stack).toEqual([]);
  expect(xml).not.toMatch(/&(?!(amp|lt|gt|quot|apos|#\d+);)/);
}

describe('JSON reporter', () => {
  it('renders the versioned document unchanged and machine-readable', () => {
    const report = sampleReport();
    const rendered = jsonReporter.render(report);
    const parsed = JSON.parse(rendered) as typeof report;
    expect(parsed).toEqual(report);
    expect(parsed.schemaVersion).toBe(1);
    expect(rendered.endsWith('\n')).toBe(true);
    expect(rendered).toContain('"schemaVersion": 1');
  });

  it('keeps optional fields out of the output instead of writing undefined', () => {
    const report = sampleReport({ scenario: { error: undefined, description: undefined } });
    const rendered = jsonReporter.render(report);
    expect(rendered).not.toContain('undefined');
  });
});

describe('Markdown reporter', () => {
  it('summarizes a passing run with checks and environment details', () => {
    const markdown = markdownReporter.render(sampleReport());
    expect(markdown).toContain('# UpgradeLab report');
    expect(markdown).toContain('sample-app');
    expect(markdown).toContain('PASSED');
    expect(markdown).toContain('upgrade-1-to-2');
    expect(markdown).toContain('users-preserved');
    expect(markdown).toContain('application-healthy');
    expect(markdown).toContain('docker-compose');
    expect(markdown).toContain('database migration applied for 2.0.0');
  });

  it('highlights failures with the failure message and remediation context', () => {
    const failedCheck = {
      ...sampleScenario().checks[0]!,
      status: 'FAILED' as const,
      message: 'Value changed during the upgrade: before 3, after 2.',
      expected: 3,
      actual: 2,
    };
    const markdown = markdownReporter.render(
      sampleReport({
        scenario: {
          status: 'FAILED',
          checks: [failedCheck],
          counts: { total: 1, passed: 0, failed: 1, skipped: 0, errored: 0 },
        },
      }),
    );
    expect(markdown).toContain('FAILED');
    expect(markdown).toContain('before 3, after 2');
    expect(markdown).toMatch(/fail/i);
  });

  it('renders AI advisories with a mandatory disclaimer', () => {
    const advisory = {
      kind: 'failure-explanation',
      scenarioId: 'upgrade-1-to-2',
      model: 'gpt-test',
      provider: 'openai',
      generatedAt: '2024-01-01T00:00:10.000Z',
      summary: 'The migration drops the email column.',
      suggestions: [{ title: 'Keep the column', detail: 'Backfill it first.' }],
      redactionsApplied: 2,
      disclaimer: 'AI output is advisory only.',
    };
    const report = sampleReport({ scenario: { aiAdvisories: [advisory] } });
    const withAi = {
      ...report,
      ai: {
        enabled: true,
        provider: 'openai',
        model: 'gpt-test',
        advisories: [advisory],
      },
    };
    const markdown = markdownReporter.render(withAi);
    expect(markdown).toContain('AI');
    expect(markdown).toContain('The migration drops the email column.');
    expect(markdown).toContain('Keep the column');
    expect(markdown).toContain('advisory only');
  });

  it('escapes table-breaking characters in messages', () => {
    const check = { ...sampleScenario().checks[0]!, message: 'a | b\nc' };
    const markdown = markdownReporter.render(sampleReport({ scenario: { checks: [check] } }));
    expect(markdown).not.toContain('a | b\nc');
  });
});

describe('JUnit reporter', () => {
  it('emits well-formed XML with one test case per check and synthetic cases', () => {
    const xml = junitReporter.render(sampleReport());
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expectWellFormedXml(xml);
    expect(xml).toContain('<testsuites');
    expect(xml).toContain('<testsuite');
    expect(xml).toContain('name="invariant:users-preserved"');
    expect(xml).toContain('name="assertion:application-healthy"');
    expect(xml).toContain('name="setup:setup-1"');
    expect(xml).toContain('<system-out>');
    expect(xml).not.toContain('<failure');
  });

  it('marks failed, skipped and errored cases with the right elements', () => {
    const checks = [
      { ...sampleScenario().checks[0]!, id: 'passed' },
      {
        ...sampleScenario().checks[0]!,
        id: 'failed',
        status: 'FAILED' as const,
        message: 'mismatch',
      },
      { ...sampleScenario().checks[0]!, id: 'skipped', status: 'SKIPPED' as const },
      { ...sampleScenario().checks[0]!, id: 'errored', status: 'ERROR' as const },
    ];
    const xml = junitReporter.render(
      sampleReport({
        scenario: {
          status: 'FAILED',
          checks,
          counts: { total: 4, passed: 1, failed: 1, skipped: 1, errored: 1 },
        },
      }),
    );
    expectWellFormedXml(xml);
    expect(xml).toMatch(/name="invariant:failed"[\s\S]*?<failure/);
    expect(xml).toMatch(/name="invariant:skipped"[\s\S]*?<skipped/);
    expect(xml).toMatch(/name="invariant:errored"[\s\S]*?<error/);
  });

  it('escapes XML special characters', () => {
    const check = {
      ...sampleScenario().checks[0]!,
      id: 'special',
      status: 'FAILED' as const,
      message: 'expected <a> & "b" \'c\'',
    };
    const xml = junitReporter.render(
      sampleReport({ scenario: { status: 'FAILED', checks: [check] } }),
    );
    expectWellFormedXml(xml);
    expect(xml).toContain('&lt;a&gt;');
    expect(xml).toContain('&amp;');
    expect(xml).toContain('&quot;');
  });
});

describe('reporter registry', () => {
  it('resolves documented aliases and rejects unknown formats', () => {
    const registry = new ReporterRegistry();
    expect(registry.resolve('md').format).toBe('markdown');
    expect(registry.resolve('xml').format).toBe('junit');
    expect(registry.resolve('JUNIT-XML').format).toBe('junit');
    expect(registry.list()).toEqual(['json', 'junit', 'markdown']);
    expect(() => registry.resolve('pdf')).toThrowError(/Unknown report format/);
  });

  it('never allows a plugin to override a built-in format', () => {
    const registry = new ReporterRegistry();
    const fake: Reporter = { format: 'json', fileExtension: 'json', render: () => '{}' };
    expect(() => registry.register(fake)).toThrowError(/already registered/);
  });

  it('accepts plugin formats and renders them through the writer', async () => {
    const registry = new ReporterRegistry();
    registry.register({
      format: 'text',
      fileExtension: 'txt',
      render: (report) => `${report.run.status}\n`,
    });
    const directory = await mkdtemp(path.join(os.tmpdir(), 'upgradelab-writer-'));
    temporaryDirectories.push(directory);
    const result = await writeReports(
      sampleReport(),
      {
        outputDirectory: path.join(directory, 'nested', 'reports'),
        formats: ['json', 'text', 'md'],
        redactor: createRedactor(),
        logger,
        baseName: 'custom-report',
      },
      registry,
    );
    expect(result.files.map((file) => file.format).sort()).toEqual(['json', 'markdown', 'text']);
    const text = await readFile(
      result.files.find((file) => file.format === 'text')?.path ?? '',
      'utf8',
    );
    expect(text).toBe('PASSED\n');
    expect(
      result.files.find((file) => file.format === 'markdown')?.path.endsWith('custom-report.md'),
    ).toBe(true);
  });
});
