// Validate public release configuration before contacting CloudBase.
const required = ['TCB_ENV_ID', 'TCB_REGION', 'API_URL', 'WEB_ORIGIN', 'VITE_AUTH_MODE'];
for (const name of required) {
  if (!process.env[name]?.trim()) throw new Error(`Missing repository variable: ${name}`);
}
if (!/^[A-Za-z0-9_-]+$/.test(process.env.TCB_ENV_ID))
  throw new Error('TCB_ENV_ID must be the environment ID, not its display name.');
if (!/^[a-z]{2}-[a-z0-9-]+$/.test(process.env.TCB_REGION))
  throw new Error('TCB_REGION must be a region code such as ap-shanghai.');
const origin = new URL(process.env.WEB_ORIGIN);
if (origin.protocol !== 'https:' || origin.origin !== process.env.WEB_ORIGIN)
  throw new Error('WEB_ORIGIN must be an HTTPS origin without a path or trailing slash.');
const api = new URL(process.env.API_URL);
if (
  api.protocol !== 'https:' ||
  api.username ||
  api.password ||
  api.search ||
  api.hash ||
  api.pathname !== '/api/avalon'
)
  throw new Error('API_URL must be the complete HTTPS gateway URL ending in /api/avalon.');
if (!['guest', 'wechat'].includes(process.env.VITE_AUTH_MODE))
  throw new Error('AUTH_MODE must be guest for testing or wechat for the official account.');
console.log('PASS: deployment variables are valid.');
