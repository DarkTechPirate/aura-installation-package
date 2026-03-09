// Patterns for common API key formats
const SECRET_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  { name: 'anthropic',    pattern: /sk-ant-api\d{2}-[A-Za-z0-9\-_]{20,}/g },
  { name: 'openai',       pattern: /sk-[A-Za-z0-9]{20,}/g },
  { name: 'aws_access',   pattern: /AKIA[0-9A-Z]{16}/g },
  { name: 'aws_secret',   pattern: /(?<![A-Za-z0-9/+])[A-Za-z0-9/+=]{40}(?![A-Za-z0-9/+=])/g },
  { name: 'google_api',   pattern: /AIza[0-9A-Za-z\-_]{35}/g },
  { name: 'telegram_bot', pattern: /\d{8,10}:[A-Za-z0-9\-_]{35}/g },
  { name: 'github_pat',   pattern: /ghp_[A-Za-z0-9]{36}/g },
  { name: 'slack_token',  pattern: /xox[baprs]-[A-Za-z0-9\-]+/g },
];

export function scanSecrets(text: string): { text: string; count: number } {
  let count = 0;
  let result = text;
  for (const { pattern } of SECRET_PATTERNS) {
    result = result.replace(pattern, (match) => {
      count++;
      const preview = match.slice(0, 6);
      return `${preview}...[REDACTED]`;
    });
  }
  return { text: result, count };
}
