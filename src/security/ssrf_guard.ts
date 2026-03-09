import dns from 'dns/promises';

const PRIVATE_RANGES = [
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^169\.254\./,
  /^::1$/,
  /^fc00:/i,
  /^fe80:/i,
];

function isPrivate(ip: string): boolean {
  return PRIVATE_RANGES.some(r => r.test(ip));
}

export async function checkSsrf(urlStr: string): Promise<void> {
  let hostname: string;
  try {
    hostname = new URL(urlStr).hostname;
  } catch {
    throw new Error(`Invalid URL: ${urlStr}`);
  }
  // Block obvious private hostnames
  if (hostname === 'localhost' || hostname === '0.0.0.0') {
    throw new Error(`SSRF blocked: ${hostname} is not allowed`);
  }
  // Resolve and check each returned IP
  try {
    const result = await dns.lookup(hostname, { all: true });
    for (const { address } of result) {
      if (isPrivate(address)) {
        throw new Error(`SSRF blocked: ${hostname} resolves to private IP ${address}`);
      }
    }
  } catch (err) {
    if ((err as Error).message.startsWith('SSRF blocked')) throw err;
    // DNS failures: let it through (external service down is handled elsewhere)
  }
}
