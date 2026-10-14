import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

const startup = resolve('k8s/gitops/omniroute/startup.sh');
const manage = resolve('k8s/gitops/omniroute/manage.mjs');
const wrapper = resolve('k8s/gitops/omniroute/manage-wrapper.mjs');

function run(command, args, env) {
  return new Promise((resolveRun, reject) => {
    const proc = spawn(command, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', chunk => { stdout += chunk; });
    proc.stderr.on('data', chunk => { stderr += chunk; });
    proc.once('error', reject);
    proc.once('close', code => resolveRun({ code, stdout, stderr }));
  });
}

test('startup imports native OAuth credentials once and delegates routing aliases to Flux', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'omniroute-config-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'codex.json'), JSON.stringify({ tokens: { access_token: 'codex-private', refresh_token: 'codex-refresh' } }));
  await writeFile(join(dir, 'agy.json'), JSON.stringify({ token: { access_token: 'agy-private', refresh_token: 'agy-refresh' } }));
  const connections = [];
  const aliases = {};
  const events = [];
  const api = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;
    const reply = (status, obj) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (path === '/healthz') return reply(200, { ok: true });
    if (path === '/api/cli/connect' && req.method === 'POST') {
      assert.equal(body.password, 'operator-secret');
      events.push('token');
      return reply(200, { token: 'startup-bearer' });
    }
    if (req.headers.authorization !== 'Bearer startup-bearer') return reply(401, { error: 'unauthorized' });
    if (path === '/api/providers' && req.method === 'GET') return reply(200, { connections });
    if (path.startsWith('/api/providers/') && path.endsWith('/import') && req.method === 'POST') {
      const provider = path.includes('/codex-') ? 'codex' : 'agy';
      events.push(`oauth:${provider}`);
      assert.equal(body.overwriteExisting, provider === 'agy');
      assert.equal(body.source.kind, 'json');
      const connection = { provider, name: body.name, id: String(connections.length + 1), isActive: true };
      connections.push(connection);
      return reply(200, { connection });
    }
    if (path === '/api/providers' && req.method === 'POST') {
      events.push(`create:${body.provider}`);
      const connection = { provider: body.provider, name: body.name, id: String(connections.length + 1), defaultModel: body.defaultModel, isActive: true };
      connections.push(connection);
      return reply(200, { connection });
    }
    if (path.startsWith('/api/providers/') && req.method === 'PUT') {
      events.push(`update:${path.split('/').pop()}`);
      assert.ok(body.apiKey);
      return reply(200, { success: true });
    }
    if (path === '/api/settings/model-aliases' && req.method === 'GET') return reply(200, { custom: aliases });
    if (path === '/api/settings/model-aliases' && req.method === 'POST') {
      events.push(`alias:${body.from}`);
      aliases[body.from] = body.to;
      return reply(200, { success: true });
    }
    return reply(404, { error: `${req.method} ${path}` });
  });
  await new Promise((resolveServer, reject) => api.once('error', reject).listen(0, '127.0.0.1', resolveServer));
  t.after(() => api.close());
  const port = api.address().port;
  const env = {
    OR_BASE_URL: `http://127.0.0.1:${port}`, OR_MANAGE_SCRIPT: wrapper,
    INITIAL_PASSWORD: 'operator-secret', ZAI_API_KEY: 'zai-private', OPENCODE_API_KEY: 'zen-private',
    OR_CODEX_AUTH_FILE: join(dir, 'codex.json'), OR_AGY_AUTH_FILE: join(dir, 'agy.json'),
    OR_WAIT_SECONDS: '2', OR_WAIT_INTERVAL: '1', OR_LOG_TO_PID1: '0',
  };
  const first = await run('sh', [startup], env);
  assert.equal(first.code, 0, first.stderr);
  assert.equal(connections.length, 4);
  assert.equal(Object.keys(aliases).length, 0);
  assert.deepEqual(events.filter(e => e.startsWith('oauth:')), ['oauth:codex', 'oauth:agy']);
  const second = await run('sh', [startup], {
    ...env,
    OR_CODEX_NAME: 'another configured name',
    OR_AGY_NAME: 'another configured name',
    OR_CODEX_AUTH_FILE: '/nonexistent/codex.json',
    OR_AGY_AUTH_FILE: '/nonexistent/agy.json',
  });
  assert.equal(second.code, 0, second.stderr);
  assert.equal(connections.length, 4);
  assert.equal(events.filter(e => e.startsWith('oauth:')).length, 2);
  assert.equal(events.filter(e => e.startsWith('create:')).length, 2);
  assert.equal(events.filter(e => e.startsWith('update:')).length, 2);
  assert.equal(events.filter(e => e.startsWith('alias:')).length, 0);
  for (const secret of ['operator-secret', 'startup-bearer', 'zai-private', 'zen-private', 'codex-private', 'agy-private']) {
    assert.equal((first.stdout + first.stderr + second.stdout + second.stderr).includes(secret), false);
  }
});

test('missing credentials fail explicitly before creating a provider', async () => {
  const result = await run('node', [manage, 'upsert-key', 'glm', 'name', 'model', 'MISSING_TEST_CREDENTIAL'], {
    OR_BASE_URL: 'http://127.0.0.1:1', MISSING_TEST_CREDENTIAL: '',
  });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /MISSING_TEST_CREDENTIAL is unset/);
});

test('cross-origin OAuth import endpoints are refused before credentials are read', async t => {
  const api = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ connections: [] }));
  });
  await new Promise((ok, fail) => api.once('error', fail).listen(0, '127.0.0.1', ok));
  t.after(() => api.close());
  const result = await run('node', [manage, 'import-oauth', 'agy', 'test', '/nonexistent', '//external.example/api'], {
    OR_BASE_URL: `http://127.0.0.1:${api.address().port}`, OMNIROUTE_API_KEY: 'secret',
  });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Only local API paths/);
  assert.doesNotMatch(result.stderr, /secret/);
});
