// Thin idempotent caller for the native OmniRoute management REST API.
// No custom provider schema, separate binary, or CLI runtime dependencies.
import { readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const base = (process.env.OR_BASE_URL || 'http://127.0.0.1:20128').replace(/\/$/, '');
const [operation, ...args] = process.argv.slice(2);
const requestTimeout = Number(process.env.OR_REQUEST_TIMEOUT_MS || 15000);
if (!Number.isInteger(requestTimeout) || requestTimeout < 1000 || requestTimeout > 120000) {
  throw new Error('OR_REQUEST_TIMEOUT_MS must be between 1000 and 120000');
}

function localUrl(endpoint) {
  if (!endpoint.startsWith('/') || endpoint.startsWith('//')) {
    throw new Error('Only local API paths are allowed');
  }
  const url = new URL(endpoint, base);
  if (url.origin !== new URL(base).origin) throw new Error('Cross-origin management call refused');
  return url;
}

async function api(method, endpoint, body, token = process.env.OMNIROUTE_API_KEY) {
  const headers = { accept: 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(localUrl(endpoint), {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(requestTimeout),
  });
  // Never print server error bodies; OAuth imports may include credential data.
  if (!response.ok) throw new Error(`${method} ${endpoint}: HTTP ${response.status}`);
  return response.json();
}

async function list() {
  const body = await api('GET', '/api/providers?limit=5000');
  if (!Array.isArray(body.connections)) throw new Error('Invalid provider list response');
  return body.connections;
}

async function main() {
  switch (operation) {
    case 'wait': {
      const deadline = Date.now() + Number(args[0] || 240) * 1000;
      const delay = Number(args[1] || 3) * 1000;
      while (Date.now() < deadline) {
        try {
          const response = await fetch(new URL('/healthz', base), {
            signal: AbortSignal.timeout(3000),
          });
          if (response.ok) return;
        } catch { /* startup transient */ }
        await sleep(delay);
      }
      throw new Error('OmniRoute /healthz never became ready');
    }
    case 'token': {
      if (process.env.OR_MANAGEMENT_TOKEN) {
        try {
          await api('GET', '/api/providers', undefined, process.env.OR_MANAGEMENT_TOKEN);
          process.stdout.write(process.env.OR_MANAGEMENT_TOKEN);
          return;
        } catch { /* fall through to a fresh token */ }
      }
      if (!process.env.INITIAL_PASSWORD) throw new Error('INITIAL_PASSWORD is required');
      const body = await api('POST', '/api/cli/connect', {
        password: process.env.INITIAL_PASSWORD,
        name: 'llm-runtime-startup',
        scope: 'admin',
        expiresInDays: 7,
      }, '');
      if (typeof body.token !== 'string' || !body.token) throw new Error('Management token missing');
      process.stdout.write(body.token);
      return;
    }
    case 'upsert-key': {
      const [provider, name, model, keyEnv] = args;
      if (!provider || !name || !keyEnv || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(keyEnv)) {
        throw new Error('upsert-key requires provider, name, model, and credential env name');
      }
      const apiKey = process.env[keyEnv];
      if (!apiKey) throw new Error(`Required credential environment variable ${keyEnv} is unset`);
      const matches = (await list()).filter(c => c.provider === provider && c.name === name);
      if (matches.length > 1) throw new Error(`Ambiguous connection: ${provider}/${name}`);
      const data = { apiKey, ...(model ? { defaultModel: model } : {}) };
      if (matches.length) {
        await api('PUT', `/api/providers/${encodeURIComponent(matches[0].id)}`, data);
        console.log(`omniroute-config: updated ${provider}/${name}`);
      } else {
        const result = await api('POST', '/api/providers', { provider, name, ...data });
        if (result.connection?.provider !== provider || result.connection?.name !== name) {
          throw new Error(`Unexpected create response for ${provider}/${name}`);
        }
        console.log(`omniroute-config: created ${provider}/${name}`);
      }
      return;
    }
    case 'import-oauth': {
      const [provider, name, authFile, endpoint] = args;
      const matches = (await list()).filter(c => c.provider === provider);
      if (matches.length) {
        console.log(`omniroute-config: existing ${provider} OAuth connection(s) preserved (${matches.length})`);
        return;
      }
      if (!name || !authFile || !endpoint) throw new Error('import-oauth requires name, file and API path');
      localUrl(endpoint); // Check the destination before reading credentials.
      let raw = readFileSync(authFile, 'utf8').trim();
      // Antigravity CLI may store JSON behind its documented keyring-base64 prefix.
      if (raw.startsWith('go-keyring-base64:')) {
        raw = Buffer.from(raw.slice('go-keyring-base64:'.length), 'base64').toString('utf8');
      }
      const credentials = JSON.parse(raw);
      if (!credentials || typeof credentials !== 'object' || Array.isArray(credentials)) {
        throw new Error(`Invalid OAuth file for ${provider}`);
      }
      const result = await api('POST', endpoint, {
        source: { kind: 'json', json: credentials }, name, overwriteExisting: false,
      });
      if (result.connection?.provider !== provider) throw new Error(`Unexpected OAuth import response: ${provider}`);
      console.log(`omniroute-config: ${provider} OAuth session imported`);
      return;
    }
    case 'alias': {
      const [from, to] = args;
      if (!from || !to) return;
      const current = await api('GET', '/api/settings/model-aliases');
      if (current.custom?.[from] === to) return;
      await api('POST', '/api/settings/model-aliases', { from, to });
      console.log(`omniroute-config: alias ${from} -> ${to}`);
      return;
    }
    default:
      throw new Error(`Unknown operation: ${operation}`);
  }
}

main().catch(error => {
  // Only predefined safe error messages are emitted; never dump request bodies.
  console.error(`omniroute-config: ${error.message}`);
  process.exitCode = 1;
});
