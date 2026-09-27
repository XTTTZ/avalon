import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseEnv } from 'node:util';

const envId = process.env.TCB_ENV_ID?.trim();
const webOrigin = process.env.WEB_ORIGIN?.trim();
if (!envId) throw new Error('TCB_ENV_ID is required');
if (!webOrigin || new URL(webOrigin).origin !== webOrigin || !webOrigin.startsWith('https://'))
  throw new Error('WEB_ORIGIN must be an exact HTTPS origin');

const workspace = mkdtempSync(join(tmpdir(), 'poker-cloudbase-'));
const avalonEnvFile = join(workspace, 'avalon.env');
const pokerEnvFile = join(workspace, 'poker.env');

function command(args, options = {}) {
  const result = spawnSync('tcb', args, {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: options.env ?? process.env,
    stdio: options.capture ? 'pipe' : 'inherit',
  });
  if (result.error) throw result.error;
  return result;
}

function pullFunctionEnv(name, outputFile) {
  return command(
    ['fn', 'env', 'pull', name, '--output-file', outputFile, '--env-id', envId, '--json'],
    { capture: true },
  );
}

function hasFunction(payload, name) {
  if (Array.isArray(payload)) return payload.some((value) => hasFunction(value, name));
  if (!payload || typeof payload !== 'object') return false;
  if (
    Object.entries(payload).some(
      ([key, value]) => /^(function)?name$/i.test(key) && String(value) === name,
    )
  )
    return true;
  return Object.values(payload).some((value) => hasFunction(value, name));
}

function mask(value) {
  if (process.env.GITHUB_ACTIONS === 'true') {
    const escaped = value.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
    process.stdout.write(`::add-mask::${escaped}\n`);
  }
}

try {
  const avalonPull = pullFunctionEnv('avalon', avalonEnvFile);
  if (avalonPull.status !== 0)
    throw new Error(`Unable to read the Avalon function environment: ${avalonPull.stderr.trim()}`);
  const avalonEnv = parseEnv(readFileSync(avalonEnvFile, 'utf8'));
  if (!avalonEnv.PG_REST_URL || !avalonEnv.PG_API_KEY)
    throw new Error('Avalon function is missing PG_REST_URL or PG_API_KEY');

  let pokerEnv = {};
  const pokerPull = pullFunctionEnv('poker', pokerEnvFile);
  if (pokerPull.status === 0) {
    pokerEnv = parseEnv(readFileSync(pokerEnvFile, 'utf8'));
  } else {
    const list = command(['fn', 'list', '--env-id', envId, '--json'], { capture: true });
    if (list.status !== 0)
      throw new Error(`Unable to list CloudBase functions: ${list.stderr.trim()}`);
    const listed = JSON.parse(list.stdout);
    if (hasFunction(listed, 'poker'))
      throw new Error('Poker function exists, but its environment variables could not be read');
  }

  const sessionSecret =
    pokerEnv.POKER_SESSION_SECRET && Buffer.byteLength(pokerEnv.POKER_SESSION_SECRET) >= 32
      ? pokerEnv.POKER_SESSION_SECRET
      : randomBytes(48).toString('base64url');
  const identitySecret =
    pokerEnv.POKER_IDENTITY_SECRET && Buffer.byteLength(pokerEnv.POKER_IDENTITY_SECRET) >= 32
      ? pokerEnv.POKER_IDENTITY_SECRET
      : randomBytes(48).toString('base64url');

  const deploymentEnv = {
    ...process.env,
    TCB_ENV_ID: envId,
    WEB_ORIGIN: webOrigin,
    PG_REST_URL: avalonEnv.PG_REST_URL,
    PG_API_KEY: avalonEnv.PG_API_KEY,
    POKER_SESSION_SECRET: sessionSecret,
    POKER_IDENTITY_SECRET: identitySecret,
  };
  for (const value of [
    deploymentEnv.PG_REST_URL,
    deploymentEnv.PG_API_KEY,
    deploymentEnv.POKER_SESSION_SECRET,
    deploymentEnv.POKER_IDENTITY_SECRET,
  ])
    mask(value);

  const validate = command(['validate', '--env-id', envId], { env: deploymentEnv });
  if (validate.status !== 0) process.exit(validate.status ?? 1);
  const migrations = command(['db', 'pg', 'migration', 'up', '--env-id', envId], {
    env: deploymentEnv,
  });
  if (migrations.status !== 0) process.exit(migrations.status ?? 1);
  const deployFunction = command(
    ['fn', 'deploy', 'poker', '--deployMode', 'zip', '--force', '--yes', '--env-id', envId],
    { env: deploymentEnv },
  );
  if (deployFunction.status !== 0) process.exit(deployFunction.status ?? 1);
  const deployGateway = command(['deploy', '--only=gateway', '--env-id', envId, '--yes'], {
    env: deploymentEnv,
  });
  if (deployGateway.status !== 0) process.exit(deployGateway.status ?? 1);
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
