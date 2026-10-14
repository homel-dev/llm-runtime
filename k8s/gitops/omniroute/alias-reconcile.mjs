// Flux-managed, one-shot reconciliation of OmniRoute routing aliases.
// No sidecar, polling loop, runtime restarts, or third-party dependencies.
import { readFileSync } from 'node:fs';
import { request as httpsRequest } from 'node:https';

const desiredFile = process.env.OR_ALIASES_FILE || '/sync/aliases.json';
const omnirouteUrl = (process.env.OR_BASE_URL || 'http://omniroute.llm-runtime.svc.cluster.local:20128').replace(/\/$/, '');
const stateName = 'omniroute-rr-alias-state';
const requiredRoles = ['coder', 'planner', 'reviewer', 'enricher', 'failure-analyst', 'materializer'];
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

export function validateDesired(raw) {
  if (!raw || raw.version !== 1 || !raw.aliases || typeof raw.aliases !== 'object' || Array.isArray(raw.aliases)) {
    throw new Error('aliases.json must contain version=1 and object aliases');
  }
  if (Object.keys(raw).some(key => !['version', 'aliases'].includes(key))) {
    throw new Error('aliases.json has unknown top-level keys');
  }
  const map = raw.aliases;
  for (const role of requiredRoles) {
    if (!own(map, role)) throw new Error(`Missing RR role alias: ${role}`);
  }
  for (const [name, target] of Object.entries(map)) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,199}$/.test(name) ||
        !/^[a-zA-Z0-9][a-zA-Z0-9_.:/-]{1,299}$/.test(target) ||
        !target.includes('/') || name === target) {
      throw new Error(`Invalid or non-qualified routing alias: ${name}`);
    }
  }
  return map;
}

async function api(method, path, body, token) {
  const headers = { accept: 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${omnirouteUrl}${path}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`OmniRoute ${method} ${path}: HTTP ${res.status}`);
  return res.json();
}

// The state ConfigMap is created by Flux. Only get/patch on this named object
// is granted to this Job; no namespace-wide ConfigMap mutation privileges.
async function kube(method, body) {
  const sa = '/var/run/secrets/kubernetes.io/serviceaccount';
  const bearer = (process.env.OR_KUBE_TOKEN || readFileSync(`${sa}/token`, 'utf8')).trim();
  const ca = process.env.OR_KUBE_CA || readFileSync(`${sa}/ca.crt`, 'utf8');
  const namespace = (process.env.OR_KUBE_NAMESPACE || readFileSync(`${sa}/namespace`, 'utf8')).trim();
  const path = `/api/v1/namespaces/${encodeURIComponent(namespace)}/configmaps/${stateName}`;
  const options = {
    hostname: process.env.KUBERNETES_SERVICE_HOST || 'kubernetes.default.svc',
    port: Number(process.env.KUBERNETES_SERVICE_PORT_HTTPS || 443),
    method, path, ca,
    headers: {
      authorization: `Bearer ${bearer}`,
      accept: 'application/json',
      ...(body === undefined ? {} : { 'content-type': 'application/merge-patch+json' }),
    },
    timeout: 15000,
  };
  return new Promise((resolve, reject) => {
    const req = httpsRequest(options, res => {
      let response = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { response += chunk; if (response.length > 1024 * 1024) req.destroy(new Error('Kubernetes response too large')); });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`Kubernetes ${method} ${path}: HTTP ${res.statusCode}`)); return;
        }
        try { resolve(JSON.parse(response)); } catch { reject(new Error('Invalid Kubernetes JSON')); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('Kubernetes request timeout')));
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
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

export async function reconcile({ desired, state, managementToken, omni = api, k8s = kube }) {
  const previous = validateState(state?.data?.['state.json']);
  const [routing, settings] = await Promise.all([
    omni('GET', '/api/models/alias', undefined, managementToken),
    omni('GET', '/api/settings/model-aliases', undefined, managementToken),
  ]);
  if (!routing?.aliases || typeof routing.aliases !== 'object' || Array.isArray(routing.aliases) ||
      !settings || typeof settings !== 'object' ||
      (settings.custom !== undefined && (typeof settings.custom !== 'object' || Array.isArray(settings.custom)))) {
    throw new Error('Malformed OmniRoute alias API response; refusing mutations');
  }
  const active = routing.aliases, legacy = settings.custom || {};
  // Preflight every source collision before issuing a single write.
  for (const [name, target] of Object.entries(desired)) {
    if (own(legacy, name) && legacy[name] !== target && legacyStartupTargets[name] !== legacy[name]) {
      throw new Error(`Conflicting Settings alias: ${name}; no changes applied`);
    }
  }
  for (const [name, oldTarget] of Object.entries(previous)) {
    if (own(desired, name)) continue;
    if (own(active, name) && active[name] !== oldTarget) {
      throw new Error(`Previously owned alias was modified externally: ${name}; refusing to prune`);
    }
    if (own(legacy, name) && legacy[name] !== oldTarget) {
      throw new Error(`Previously owned Settings alias differs: ${name}; refusing to prune`);
    }
  }

  let updated = 0, deleted = 0;
  for (const [name, target] of Object.entries(desired)) {
    if (active[name] !== target) {
      await omni('PUT', '/api/models/alias', { alias: name, model: target }, managementToken);
      updated++;
    }
    if (own(legacy, name)) {
      await omni('DELETE', '/api/settings/model-aliases', { from: name }, managementToken);
    }
  }
  for (const name of Object.keys(previous)) {
    if (own(desired, name)) continue;
    if (own(active, name)) {
      await omni('DELETE', `/api/models/alias?alias=${encodeURIComponent(name)}`, undefined, managementToken);
      deleted++;
    }
    if (own(legacy, name)) {
      await omni('DELETE', '/api/settings/model-aliases', { from: name }, managementToken);
    }
  }
  const [confirmed, confirmedSettings] = await Promise.all([
    omni('GET', '/api/models/alias', undefined, managementToken),
    omni('GET', '/api/settings/model-aliases', undefined, managementToken),
  ]);
  for (const [name, target] of Object.entries(desired)) {
    if (confirmed.aliases?.[name] !== target || own(confirmedSettings.custom || {}, name)) {
      throw new Error(`Alias not reconciled: ${name}`);
    }
  }
  for (const name of Object.keys(previous)) {
    if (own(desired, name)) continue;
    if (own(confirmed.aliases || {}, name) || own(confirmedSettings.custom || {}, name)) {
      throw new Error(`Previously managed alias remains: ${name}`);
    }
  }
  // Using the state resourceVersion protects against concurrent writers.
  await k8s('PATCH', {
    metadata: { resourceVersion: state.metadata.resourceVersion },
    data: { 'state.json': JSON.stringify({ version: 1, aliases: desired }) },
  });
  return { desired: Object.keys(desired).length, updated, deleted };
}

// This entrypoint is inert when imported by the native Node test suite.
if (process.argv[1]?.endsWith('/alias-reconcile.mjs')) {
  try {
    const raw = JSON.parse(readFileSync(desiredFile, 'utf8'));
    const desired = validateDesired(raw);
    const initial = await kube('GET');
    const managementToken = await getManagementToken();
    const result = await reconcile({ desired, state: initial, managementToken });
    console.log(`OmniRoute Flux aliases reconciled: desired=${result.desired} updated=${result.updated} deleted=${result.deleted}`);
  } catch (error) {
    // Never print tokens, passwords or raw upstream error bodies.
    console.error(`OmniRoute Flux alias sync failed: ${error?.message || 'unknown error'}`);
    process.exitCode = 1;
  }
}
