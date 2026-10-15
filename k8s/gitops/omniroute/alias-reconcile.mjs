// Flux-managed, one-shot migration from direct RR aliases to Combo routing.
// No sidecar, polling loop, or runtime restarts.
import { readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import yaml from 'js-yaml';

const desiredFile = process.env.OR_ALIASES_FILE || '/opt/alias-sync/config/aliases.yaml';
const omnirouteUrl = (process.env.OR_BASE_URL || 'http://omniroute.llm-runtime.svc.cluster.local:20128').replace(/\/$/, '');
const stateFile = process.env.OR_ALIAS_STATE_FILE || '/state/state.json';
const requiredCombos = Object.freeze({
  'hodor-local-weak': 'Hodor Local Weak',
  'hodor-group-strong': 'Hodor Group Strong',
  'hodor-group-front': 'Hodor Group Front',
  'hodor-group-front-plus': 'Hodor Group Front Plus',
  'hodor-agy-strong': 'Hodor AGY Strong',
  'hodor-agy-front': 'Hodor AGY Front',
});
const retiredMappings = new Set([
  'coder', 'planner', 'reviewer', 'enricher', 'materializer', 'failure-analyst',
  'hodor-weak', 'hodor-strong', 'hodor-front', 'hodor-front-plus',
]);
const retiredCombos = new Set([
  'Coder', 'Planner', 'Reviewer', 'Enricher', 'Materializer',
  'Hodor Weak', 'Hodor Strong', 'Hodor Front', 'Hodor Front Plus',
]);
function comboModels(combo) {
  return combo.models.map(model => {
    if (typeof model === 'string') return model;
    if (!record(model) || typeof model.model !== 'string') return null;
    return model.model.includes('/') ? model.model :
      typeof model.providerId === 'string' ? `${model.providerId}/${model.model}` : model.model;
  });
}
function matchesCombo(current, desired) {
  return current.strategy === desired.strategy &&
    JSON.stringify(comboModels(current)) === JSON.stringify(desired.models);
}
// Direct aliases from the currently deployed alias-sync. These are retired,
// not recreated: OmniRoute Combo mappings become the only RR role routes.
// An alias with an unexpected target fails closed rather than being destroyed.
const retiredDirectRoles = Object.freeze({
  coder: 'glm/glm-5.3',
  planner: 'codex/gpt-5.6-sol',
  reviewer: 'codex/gpt-5.6-sol',
  enricher: 'agy/gemini-3.8-flash-high',
  'failure-analyst': 'glm/glm-5.3',
  materializer: 'glm/glm-5.3',
  'gpt-5.6-sol': 'codex/gpt-5.6-sol',
  'gemini-subscription-pro': 'agy/gemini-3.8-flash-high',
  'gemini-subscription-auto': 'agy/gemini-3.8-flash-high',
  'glm-5.3': 'glm/glm-5.3',
  'glm-5.3-flash': 'glm/glm-5.3-flash',
  'llm-large': 'vllm/Qwen3-32B-AWQ',
});
// One-time migration allowance for earlier llm-runtime Settings aliases. These
// are NOT desired-state defaults and never create or overwrite mappings.
const legacyStartupTargets = Object.freeze({
  'gpt-5.6-sol': 'codex/gpt-5.6-sol',
  'gemini-subscription-pro': 'agy/gemini-pro-agent',
  'gemini-subscription-auto': 'agy/gemini-3.7-flash-medium',
  'glm-5.3': 'glm/glm-5.3',
  'glm-5.3-flash': 'glm/glm-5.3-flash',
});
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function validateDesired(raw) {
  if (!record(raw) || raw.version !== 1 ||
      !Array.isArray(raw.combos) || !record(raw.mappings) ||
      Object.keys(raw).some(key => !['version', 'combos', 'mappings'].includes(key))) {
    throw new Error('aliases.yaml requires version=1, combos and mappings only');
  }
  const names = new Set();
  for (const combo of raw.combos) {
    if (!record(combo) || typeof combo.name !== 'string' ||
        !/^[a-zA-Z0-9][a-zA-Z0-9_. -]{0,99}$/.test(combo.name) ||
        names.has(combo.name) || !['priority', 'round-robin'].includes(combo.strategy) ||
        !Array.isArray(combo.models) || combo.models.length === 0 ||
        combo.models.some(model => typeof model !== 'string' || !/^[^\s/]+\/.+$/.test(model)) ||
        Object.keys(combo).some(key => !['name', 'strategy', 'models'].includes(key))) {
      throw new Error(`Invalid or duplicate Combo: ${combo?.name}`);
    }
    names.add(combo.name);
  }
  const expected = Object.entries(requiredCombos);
  if (names.size !== expected.length || Object.keys(raw.mappings).length !== expected.length) {
    throw new Error('Expected exactly six Hodor Combos and mappings');
  }
  for (const [role, comboName] of expected) {
    if (!names.has(comboName) || raw.mappings[role] !== comboName) {
      throw new Error(`Missing or incorrect RR Combo mapping: ${role}`);
    }
  }
  for (const [role, name] of Object.entries(raw.mappings)) {
    if (!own(requiredCombos, role) || typeof name !== 'string' || !names.has(name)) {
      throw new Error(`Invalid RR Combo mapping: ${role}`);
    }
  }
  return raw;
}

// Socket errors from undici do not include the useful cause in Error.message.
// Only emit network diagnostics, never request headers or response bodies.
function networkCode(error) {
  const cause = error?.cause || error;
  const nested = Array.isArray(cause?.errors) ? cause.errors : [cause];
  return [...new Set(nested.map(value => value?.code || value?.name).filter(Boolean))].join(',') || 'UNKNOWN';
}

async function api(method, path, body, token) {
  const headers = { accept: 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const maxAttempts = 12;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let res;
    try {
      res = await fetch(`${omnirouteUrl}${path}`, {
        method, headers, body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(10000),
      });
    } catch (error) {
      const code = networkCode(error);
      if (attempt === maxAttempts) {
        throw new Error(`OmniRoute ${method} ${path}: network ${code} after ${attempt} attempts`);
      }
      console.error(`OmniRoute ${method} ${path}: network ${code}, retry ${attempt}/${maxAttempts}`);
      await new Promise(resolve => setTimeout(resolve, Math.min(1000 * attempt, 5000)));
      continue;
    }
    if (res.ok) return res.json();
    if (![429, 502, 503, 504].includes(res.status) || attempt === maxAttempts) {
      throw new Error(`OmniRoute ${method} ${path}: HTTP ${res.status}`);
    }
    console.error(`OmniRoute ${method} ${path}: HTTP ${res.status}, retry ${attempt}/${maxAttempts}`);
    await res.body?.cancel();
    await new Promise(resolve => setTimeout(resolve, Math.min(1000 * attempt, 5000)));
  }
  throw new Error(`OmniRoute ${method} ${path}: retries exhausted`);
}

// Durable ownership state, written atomically on the dedicated PVC. Neither a
// ServiceAccount token nor network access to the Kubernetes API is required.
// The digest plays the role of the former ConfigMap resourceVersion.
export function readStateFromDisk(file = stateFile) {
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    raw = null;
  }
  if (raw !== null) validateState(raw); // corrupted state must fail closed
  return {
    metadata: { resourceVersion: createHash('sha256').update(raw ?? '').digest('hex') },
    data: raw === null ? {} : { 'state.json': raw },
  };
}

export async function writeStateToDisk(method, body, file = stateFile) {
  if (method !== 'PATCH' || typeof body?.data?.['state.json'] !== 'string') {
    throw new Error('Invalid alias ownership state update');
  }
  const current = readStateFromDisk(file);
  if (body.metadata?.resourceVersion !== current.metadata.resourceVersion) {
    throw new Error('Alias ownership state changed concurrently');
  }
  const content = body.data['state.json'];
  validateState(content);
  const tempFile = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tempFile, content, { mode: 0o600, flag: 'wx' });
    renameSync(tempFile, file);
  } catch (error) {
    try { unlinkSync(tempFile); } catch { /* may not have been created */ }
    throw error;
  }
  return readStateFromDisk(file);
}

function validateState(input) {
  if (input === undefined) return {};
  let data;
  try { data = JSON.parse(input); } catch { throw new Error('Invalid previous alias ownership state JSON'); }
  if (data?.version !== 1 || !data.aliases || typeof data.aliases !== 'object' || Array.isArray(data.aliases)) {
    throw new Error('Invalid previous alias ownership state');
  }
  for (const [name, target] of Object.entries(data.aliases)) {
    if (typeof name !== 'string' || typeof target !== 'string') throw new Error('Malformed ownership state');
  }
  return data.aliases;
}

async function getManagementToken() {
  // A pod-to-pod request must NOT mint tokens via the loopback-only CLI API.
  // Bootstrap the operator Secret using scripts/omniroute-operator-token.sh.
  const configured = process.env.OR_MANAGEMENT_TOKEN || '';
  if (!configured.startsWith('oma_live_')) {
    throw new Error('OmniRoute operator access token missing or malformed');
  }
  const who = await api('GET', '/api/cli/whoami', undefined, configured);
  if (who?.viaAccessToken !== true || who.scope !== 'admin') {
    throw new Error('OmniRoute operator access token invalid or not admin');
  }
  return configured;
}

// OmniRoute exposes paginated management collections, not a full unbounded list.
async function pages(client, path, field, token) {
  const rows = [];
  for (let offset = 0; offset < 10000; offset += 100) {
    const page = await client('GET', `${path}?limit=100&offset=${offset}`, undefined, token);
    if (!Array.isArray(page?.[field]) || !Number.isSafeInteger(page.total) || page.total < 0) {
      throw new Error(`Malformed ${path} pagination response`);
    }
    rows.push(...page[field]);
    if (rows.length >= page.total) return rows;
    if (page[field].length === 0) throw new Error(`Incomplete ${path} pagination`);
  }
  throw new Error(`Exceeded ${path} pagination limit`);
}

export async function reconcile({ desired, state, managementToken, omni = api, k8s = writeStateToDisk }) {
  const config = validateDesired(desired);
  const previous = validateState(state?.data?.['state.json']);
  const [routing, settings, initialCombos, initialMappings] = await Promise.all([
    omni('GET', '/api/models/alias', undefined, managementToken),
    omni('GET', '/api/settings/model-aliases', undefined, managementToken),
    pages(omni, '/api/combos', 'combos', managementToken),
    pages(omni, '/api/model-combo-mappings', 'mappings', managementToken),
  ]);
  if (!record(routing?.aliases) || !record(settings) ||
      (settings.custom !== undefined && !record(settings.custom))) {
    throw new Error('Malformed OmniRoute routing API response');
  }
  const active = routing.aliases;
  const legacy = settings.custom || {};
  const combos = new Map();
  const mappings = new Map();
  for (const item of initialCombos) {
    if (!record(item) || typeof item.name !== 'string' || typeof item.id !== 'string' ||
        !Array.isArray(item.models) || combos.has(item.name)) {
      throw new Error('Malformed or duplicate existing Combo');
    }
    combos.set(item.name, item);
  }
  for (const item of initialMappings) {
    if (!record(item) || typeof item.pattern !== 'string' ||
        typeof item.comboId !== 'string' || typeof item.id !== 'string' || mappings.has(item.pattern)) {
      throw new Error('Malformed or duplicate existing model-Combo mapping');
    }
    mappings.set(item.pattern, item);
  }

  // One-time migration: remove all previous direct aliases only after new
  // Combo mappings exist. Preserve unrelated, externally managed aliases.
  const obsolete = new Set([...Object.keys(previous), ...Object.keys(retiredDirectRoles)]);
  for (const name of obsolete) {
    if (own(active, name) && active[name] !== previous[name] &&
        active[name] !== retiredDirectRoles[name]) {
      throw new Error(`Obsolete alias changed externally: ${name}`);
    }
    if (own(legacy, name) && legacy[name] !== previous[name] &&
        legacy[name] !== retiredDirectRoles[name] &&
        legacy[name] !== legacyStartupTargets[name]) {
      throw new Error(`Conflicting Settings alias for retired role: ${name}`);
    }
  }
  for (const desiredCombo of config.combos) {
    const existing = combos.get(desiredCombo.name);
    if (existing && (!existing.id || !Array.isArray(existing.models))) {
      throw new Error(`Invalid existing Combo: ${desiredCombo.name}`);
    }
    // The six named Hodor Combos are owned by this GitOps document.
  }
  for (const [role, name] of Object.entries(config.mappings)) {
    const existing = mappings.get(role);
    const group = combos.get(name);
    if (existing && (!group || existing.comboId !== group.id)) {
      throw new Error(`Conflicting model-Combo mapping: ${role}`);
    }
  }

  // Build the replacement route before removing the old direct aliases.
  let createdCombos = 0, createdMappings = 0, deleted = 0;
  for (const spec of config.combos) {
    const existing = combos.get(spec.name);
    if (existing) {
      if (!matchesCombo(existing, spec)) {
        const updated = await omni('PUT', `/api/combos/${encodeURIComponent(existing.id)}`,
          { models: spec.models, strategy: spec.strategy }, managementToken);
        if (updated?.name !== spec.name || updated.id !== existing.id) {
          throw new Error(`Unexpected Combo update result: ${spec.name}`);
        }
        combos.set(spec.name, updated);
      }
      continue;
    }
    const created = await omni('POST', '/api/combos', spec, managementToken);
    if (created?.name !== spec.name || typeof created.id !== 'string') {
      throw new Error(`Unexpected Combo creation result: ${spec.name}`);
    }
    combos.set(spec.name, created);
    createdCombos++;
  }
  for (const [role, name] of Object.entries(config.mappings)) {
    if (mappings.has(role)) continue;
    const reply = await omni('POST', '/api/model-combo-mappings', {
      pattern: role, comboId: combos.get(name).id, priority: 0, enabled: true,
      description: `RR logical model ${role}`,
    }, managementToken);
    if (reply?.mapping?.pattern !== role || reply.mapping.comboId !== combos.get(name).id) {
      throw new Error(`Unexpected model-Combo mapping result: ${role}`);
    }
    mappings.set(role, reply.mapping);
    createdMappings++;
  }
  // Fail closed if a previously created mapping has subsequently been disabled.
  for (const [role, name] of Object.entries(config.mappings)) {
    const mapping = mappings.get(role);
    if (mapping.comboId !== combos.get(name)?.id || mapping.enabled === false) {
      throw new Error(`RR model-Combo mapping disabled or redirected: ${role}`);
    }
  }

  // Remove the old RR role-to-Combo routes. Internal RR flow roles do not
  // exist as independent OmniRoute aliases or Combo mappings.
  for (const name of retiredMappings) {
    const mapping = mappings.get(name);
    if (mapping) await omni('DELETE', `/api/model-combo-mappings/${encodeURIComponent(mapping.id)}`,
      undefined, managementToken);
  }
  // Delete only the previous RR-owned Combo names, after unlinking mappings.
  for (const name of retiredCombos) {
    const combo = combos.get(name);
    if (combo) await omni('DELETE', `/api/combos/${encodeURIComponent(combo.id)}`,
      undefined, managementToken);
  }

  // Actual cleanup of old direct aliases; no shadow routing or duplicate aliases.
  for (const name of obsolete) {
    if (own(active, name)) {
      await omni('DELETE', `/api/models/alias?alias=${encodeURIComponent(name)}`, undefined, managementToken);
      deleted++;
    }
    if (own(legacy, name)) {
      await omni('DELETE', '/api/settings/model-aliases', { from: name }, managementToken);
    }
  }

  const [confirmed, confirmedSettings, confirmedCombos, confirmedMappings] = await Promise.all([
    omni('GET', '/api/models/alias', undefined, managementToken),
    omni('GET', '/api/settings/model-aliases', undefined, managementToken),
    pages(omni, '/api/combos', 'combos', managementToken),
    pages(omni, '/api/model-combo-mappings', 'mappings', managementToken),
  ]);
  for (const name of obsolete) {
    if (own(confirmed.aliases || {}, name) || own(confirmedSettings.custom || {}, name)) {
      throw new Error(`Old direct alias remains: ${name}`);
    }
  }
  const groups = new Map(confirmedCombos.map(group => [group.name, group]));
  const bindings = new Map(confirmedMappings.map(mapping => [mapping.pattern, mapping]));
  for (const name of retiredMappings) {
    if (bindings.has(name)) throw new Error(`Retired RR mapping remains: ${name}`);
  }
  for (const name of retiredCombos) {
    if (groups.has(name)) throw new Error(`Retired RR Combo remains: ${name}`);
  }
  for (const spec of config.combos) {
    if (!matchesCombo(groups.get(spec.name) || { models: [] }, spec)) {
      throw new Error(`Hodor Combo drift: ${spec.name}`);
    }
  }
  for (const [role, name] of Object.entries(config.mappings)) {
    const group = groups.get(name), mapping = bindings.get(role);
    if (!group || typeof group.id !== 'string' ||
        mapping?.comboId !== group.id || mapping.enabled === false) {
      throw new Error(`RR Combo route missing or disabled: ${role}`);
    }
  }
  // Keep the existing PVC state format, lock and atomic rename unchanged.
  await k8s('PATCH', {
    metadata: { resourceVersion: state.metadata.resourceVersion },
    data: { 'state.json': JSON.stringify({ version: 1, aliases: {} }) },
  });
  return { deleted, createdCombos, createdMappings };
}

// This entrypoint is inert when imported by the native Node test suite.
if (process.argv[1]?.endsWith('/alias-reconcile.mjs')) {
  try {
    const raw = yaml.load(readFileSync(desiredFile, 'utf8'), { json: false });
    const desired = validateDesired(raw);
    const initial = readStateFromDisk();
    const managementToken = await getManagementToken();
    const result = await reconcile({ desired, state: initial, managementToken, k8s: writeStateToDisk });
    console.log(`OmniRoute RR routing reconciled: deletedAliases=${result.deleted} combos=${result.createdCombos} mappings=${result.createdMappings}`);
  } catch (error) {
    // Never print tokens, passwords or raw upstream error bodies.
    console.error(`OmniRoute Flux alias sync failed: ${error?.message || 'unknown error'}`);
    process.exitCode = 1;
  }
}
