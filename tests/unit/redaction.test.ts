import { describe, expect, it } from 'vitest';
import { createRedactor, redactDeep, redactText } from '@upgradelab/contracts';

describe('secret redaction', () => {
  it('redacts credentials in connection strings but keeps the scheme', () => {
    const redacted = redactText('postgres://upgradelab:sup3rsecret@db:5432/upgradelab');
    expect(redacted).not.toContain('sup3rsecret');
    expect(redacted).toContain('postgres://');
    expect(redacted).toContain('[REDACTED]');
  });

  it('redacts authorization headers and known token formats', () => {
    const input = [
      'Authorization: Bearer abcdefghijklmnop',
      'token=ghp_abcdefghijklmnopqrstuvwxyz0123456789',
      'key: sk-abcdefghijklmnopqrstuvwx',
      'aws AKIAIOSFODNN7EXAMPLE',
      'jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop',
      'google AIzaSyA1234567890abcdefghijklmnopqrstuv',
    ].join('\n');
    const redacted = redactText(input);
    for (const secret of [
      'abcdefghijklmnop',
      'ghp_abc',
      'sk-abcdef',
      'AKIAIOSFODNN7EXAMPLE',
      'eyJzdWIi',
      'AIzaSyA12345',
    ]) {
      expect(redacted).not.toContain(secret);
    }
    expect(redacted).toContain('Bearer [REDACTED]');
  });

  it('redacts password assignments and query parameters', () => {
    const redacted = redactText(
      'POSTGRES_PASSWORD=hunter2\n{"api_key":"abcd1234"}\nhttps://example.test/cb?token=abc123&x=1',
    );
    expect(redacted).not.toContain('hunter2');
    expect(redacted).not.toContain('abcd1234');
    expect(redacted).not.toContain('token=abc123');
    expect(redacted).toContain('POSTGRES_PASSWORD=[REDACTED]');
    expect(redacted).toContain('token=[REDACTED]');
  });

  it('redacts literal secrets supplied by configuration', () => {
    const redactor = createRedactor({ secrets: ['very-secret-value'] });
    expect(redactor.redact('value is very-secret-value here')).toBe('value is [REDACTED] here');
    expect(redactor.redactionCount).toBe(1);
    // Short values are ignored to avoid destroying unrelated output.
    const short = createRedactor({ secrets: ['abc'] });
    expect(short.redact('abc def')).toBe('abc def');
  });

  it('redacts PEM private keys entirely', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----';
    expect(redactText(pem)).toBe('[REDACTED]');
  });

  it('redacts sensitive object keys and nested values', () => {
    const value = {
      project: 'demo',
      database: { password: 'p@ssword', host: 'db' },
      headers: { authorization: 'Bearer token-value-here' },
      list: [{ token: 'another-token' }],
    };
    const redacted = redactDeep(value);
    expect(redacted.database.password).toBe('[REDACTED]');
    expect(redacted.headers.authorization).toBe('[REDACTED]');
    expect(redacted.list[0]?.token).toBe('[REDACTED]');
    expect(redacted.project).toBe('demo');
    expect(redacted.database.host).toBe('db');
  });

  it('handles circular structures without throwing', () => {
    const value: Record<string, unknown> = { name: 'loop' };
    value['self'] = value;
    const redacted = redactDeep(value) as Record<string, unknown>;
    expect(redacted['self']).toBe('[Circular]');
  });

  it('leaves harmless text unchanged', () => {
    const text = 'Upgrade from app:1.0.0 to app:2.0.0 preserved 3 users.';
    expect(redactText(text)).toBe(text);
  });
});
