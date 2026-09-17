/** Read-only post-deploy smoke test. No account or room is created. */
export {};
const endpoint = process.env.CLOUD_SMOKE_API_URL;
if (!endpoint || new URL(endpoint).protocol !== 'https:')
  throw new Error('Set CLOUD_SMOKE_API_URL to your HTTPS function URL.');
const origin = process.env.CLOUD_SMOKE_ORIGIN;
const response = await fetch(endpoint, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) },
  body: JSON.stringify({ action: 'get', code: '000000' }),
  signal: AbortSignal.timeout(20000),
});
const data = (await response.json()) as { ok?: boolean; error?: { code?: string } };
if (data.ok !== false || data.error?.code !== 'UNAUTHORIZED')
  throw new Error('Authentication boundary failed or function is misconfigured.');
if (response.headers.get('cache-control')?.includes('no-store') !== true)
  throw new Error('Missing no-store response header.');
if (origin && response.headers.get('access-control-allow-origin') !== origin)
  throw new Error('Allowed origin is not configured.');
console.log(
  'PASS: HTTPS function responds, anonymous room access is rejected, private responses are not cached.',
);
