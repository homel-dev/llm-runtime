// Thin caller for OmniRoute endpoints which its native CLI does not expose:
// importing existing OAuth credential files, aliases and the initial CLI token.
// Provider CRUD for API keys stays in the official OmniRoute CLI.
import { readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const base = (process.env.OR_BASE_URL || 'http://127.0.0.1:20128').replace(/\/$/, '');
const [operation, ...args] = process.argv.slice(2);

async function api(method, endpoint, body, token = process.env.OMNIROUTE_API_KEY) {
  const headers = { accept: 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(new URL(endpoint, base), {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
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
    case 'find': {
      const [provider, name] = args;
      const matches = (await list()).filter(c => c.provider === provider && c.name === name);
      if (matches.length > 1) throw new Error(`Ambiguous connection: ${provider}/${name}`);
      if (matches.length === 1) process.stdout.write(String(matches[0].id));
      return;
    }
    case 'import-oauth': {
      const [provider, name, authFile, endpoint] = args;
      const exists = (await list()).some(c => c.provider === provider);
      if (exists) {
        console.log(`omniroute-config: existing ${provider} OAuth session preserved`);
        return;
      }
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
