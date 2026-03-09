import { describe, it, expect } from 'vitest';
import { scanSecrets } from '../security/secret_scanner.js';

describe('scanSecrets', () => {
  it('redacts Anthropic API keys', () => {
    const text = 'key=sk-ant-api03-ABCDEFGHIJKLMNOPQRST1234567890';
    const { text: out, count } = scanSecrets(text);
    expect(count).toBe(1);
    expect(out).toContain('[REDACTED]');
    expect(out).not.toContain('ABCDEFGHIJKLMNOPQRST');
  });

  it('redacts GitHub PATs', () => {
    const token = 'ghp_' + 'A'.repeat(36);
    const { text: out, count } = scanSecrets(`token: ${token}`);
    expect(count).toBe(1);
    expect(out).toContain('[REDACTED]');
    expect(out).not.toContain(token);
  });

  it('redacts multiple secrets in one string', () => {
    const text = `OPENAI=sk-${'X'.repeat(25)} SLACK=xoxb-123-abc`;
    const { count } = scanSecrets(text);
    expect(count).toBeGreaterThanOrEqual(2);
  });

  it('leaves clean text unchanged', () => {
    const text = 'Hello, world! No secrets here.';
    const { text: out, count } = scanSecrets(text);
    expect(count).toBe(0);
    expect(out).toBe(text);
  });

  it('preserves a short prefix of the redacted secret for debugging', () => {
    const token = 'ghp_' + 'B'.repeat(36);
    const { text: out } = scanSecrets(token);
    // First 6 chars of the original token should appear before [REDACTED]
    expect(out).toContain(token.slice(0, 6));
  });
});
