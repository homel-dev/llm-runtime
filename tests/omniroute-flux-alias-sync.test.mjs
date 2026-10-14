import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { validateDesired, reconcile } from '../k8s/gitops/omniroute/alias-reconcile.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const desired = validateDesired(JSON.parse(readFileSync(resolve(root, 'k8s/gitops/omniroute/aliases.json'), 'utf8')));
const roles = ['coder', 'planner', 'reviewer', 'enricher', 'failure-analyst', 'materializer'];

test('Pi sends exact RR logical roles; planner/reviewer use Codex Responses targets', () => {
  assert.deepEqual(roles.filter(role => !Object.hasOwn(desired, role)), []);
  assert.equal(desired.coder, 'glm/glm-5.3');
  assert.equal(desired.planner, 'codex/gpt-5.6-sol');
  assert.equal(desired.reviewer, 'codex/gpt-5.6-sol');
  assert.equal(desired.materializer, 'glm/glm-5.3');
  assert.equal(desired['failure-analyst'], 'glm/glm-5.3');
  assert.equal(desired.enricher, 'agy/gemini-3.8-flash-high');
  assert.equal(Object.hasOwn(desired, 'rr-coder'), false);
  assert.equal(Object.hasOwn(desired, 'rr-hodor'), false);
});

test('invalid or incomplete alias manifest is rejected before external actions', () => {
  assert.throws(() => validateDesired({ version: 1, aliases: { coder: 'glm/glm-5.3' } }), /Missing RR role alias/);
  assert.throws(() => validateDesired({ version: 1, aliases: { ...desired, planner: 'gpt' } }), /Invalid or non-qualified/);
  assert.throws(() => validateDesired({ version: 2, aliases: desired }), /version=1/);
});

function harness({ initial = {}, settings = {}, stateMap = {} } = {}) {
  const routing = { external: 'openrouter/unrelated', ...initial };
  const legacy = { ...settings };
  const events = [];
  const state = { metadata: { resourceVersion: '7' }, data: { 'state.json': JSON.stringify({ version: 1, aliases: stateMap }) } };
  async function omni(method, path, body) {
    events.push([method, path, body]);
    if (method === 'GET' && path === '/api/models/alias') return { aliases: { ...routing } };
    if (method === 'GET' && path === '/api/settings/model-aliases') return { custom: { ...legacy } };
    if (method === 'PUT' && path === '/api/models/alias') { routing[body.alias] = body.model; return { success: true }; }
    if (method === 'DELETE' && path === '/api/settings/model-aliases') { delete legacy[body.from]; return { success: true }; }
    if (method === 'DELETE' && path.startsWith('/api/models/alias?alias=')) { delete routing[new URL('http://local' + path).searchParams.get('alias')]; return { success: true }; }
    throw new Error(`unexpected ${method} ${path}`);
  }
  async function k8s(method, patch) {
    assert.equal(method, 'PATCH');
    assert.equal(patch.metadata.resourceVersion, state.metadata.resourceVersion);
    state.data = { ...state.data, ...patch.data };
    events.push([method, 'k8s-state']);
    state.metadata.resourceVersion = String(Number(state.metadata.resourceVersion) + 1);
    return state;
  }
  return { routing, legacy, events, state, omni, k8s };
}

async function run(h, aliases = desired) {
  return reconcile({ desired: aliases, state: h.state, managementToken: 'secret-test-token', omni: h.omni, k8s: h.k8s });
}

test('create and update aliases, preserve foreign keys, readback and idempotence', async () => {
  const h = harness();
  const first = await run(h);
  assert.equal(first.updated, Object.keys(desired).length);
  assert.equal(h.routing.external, 'openrouter/unrelated');
  for (const [alias, model] of Object.entries(desired)) assert.equal(h.routing[alias], model);
  const second = await run(h);
  assert.equal(second.updated, 0);
  assert.equal(second.deleted, 0);
  assert.equal(h.events.filter(x => x[0] === 'PUT').length, Object.keys(desired).length);
});

test('prune only previously GitOps-owned aliases, refuse changed external values', async () => {
  const h = harness();
  await run(h);
  const removed = { ...desired };
  delete removed['gemini-subscription-pro'];
  const count = h.events.length;
  const out = await run(h, removed);
  assert.equal(out.deleted, 1);
  assert.equal(Object.hasOwn(h.routing, 'gemini-subscription-pro'), false);
  assert.equal(h.routing.external, 'openrouter/unrelated');
  assert.ok(h.events.slice(count).some(x => x[0] === 'DELETE' && x[1].includes('alias?alias=gemini-subscription-pro')));
  h.routing.planner = 'codex/gpt-5.6-sol';
  const reduced = { ...removed };
  delete reduced.planner;
  const before = h.events.length;
  h.routing.planner = 'openrouter/foreign';
  await assert.rejects(() => run(h, reduced), /modified externally/);
  assert.equal(h.events.slice(before).filter(x => x[0] === 'PUT' || x[0] === 'DELETE').length, 0);
});

test('legacy startup Settings aliases are migrated; arbitrary shadowed aliases fail closed', async () => {
  const h = harness({ settings: { 'gemini-subscription-pro': 'agy/gemini-pro-agent' } });
  await run(h);
  assert.equal(Object.hasOwn(h.legacy, 'gemini-subscription-pro'), false);
  assert.equal(h.routing['gemini-subscription-pro'], 'agy/gemini-3.8-flash-high');
  const bad = harness({ settings: { planner: 'custom/unknown' } });
  await assert.rejects(() => run(bad), /Conflicting Settings alias: planner/);
  assert.equal(bad.events.filter(x => ['PUT', 'DELETE'].includes(x[0])).length, 0);
});

test('state patch failure prevents claiming a successful sync', async () => {
  const h = harness();
  h.k8s = async () => { throw new Error('state not persisted'); };
  await assert.rejects(() => run(h), /state not persisted/);
});
