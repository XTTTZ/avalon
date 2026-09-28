import { randomBytes } from 'node:crypto';

const endpoint = process.env.POKER_API_URL;
const origin = process.env.WEB_ORIGIN;
if (!endpoint || !origin) throw new Error('POKER_API_URL and WEB_ORIGIN are required');

async function verify() {
  const preflight = await fetch(endpoint, {
    method: 'OPTIONS',
    headers: { Origin: origin, 'Access-Control-Request-Method': 'POST' },
    signal: AbortSignal.timeout(15_000),
  });
  if (preflight.status !== 204 || preflight.headers.get('access-control-allow-origin') !== origin)
    throw new Error(`Poker preflight failed with ${preflight.status}`);

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'auth.guest',
      deviceSecret: randomBytes(32).toString('hex'),
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const payload = await response.json();
  if (!response.ok || payload?.ok !== true || !payload?.data?.token)
    throw new Error(`Poker guest login failed with ${response.status}`);
}

let lastError;
for (let attempt = 1; attempt <= 8; attempt++) {
  try {
    await verify();
    console.log('Poker CloudBase API is ready.');
    process.exit(0);
  } catch (error) {
    lastError = error;
    if (attempt < 8) await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
}
throw lastError;
