const baseUrl = "http://127.0.0.1:20128";
const token = process.env.OR_TOKEN || "";
const glmKeyB64 = process.env.GLM_API_KEY_B64 || "";

if (!token) throw new Error("OR_TOKEN is required");
if (!glmKeyB64) throw new Error("GLM_API_KEY_B64 is required");

const glmApiKey = Buffer.from(glmKeyB64, "base64").toString("utf8").trim();
if (!glmApiKey) throw new Error("rr-zai-coding/api-key is empty");

async function api(path, { method = "GET", body } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      accept: "application/json",
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
  }
  if (!response.ok) {
    throw new Error(`${method} ${path} -> ${response.status}: ${text || response.statusText}`);
  }
  return payload;
}

async function listConnections() {
  const payload = await api("/api/providers");
  return Array.isArray(payload?.connections) ? payload.connections : [];
}

async function upsertConnection({ provider, name, apiKey, defaultModel, providerSpecificData }) {
  const existing = (await listConnections()).find(
    (connection) => connection.provider === provider && connection.name === name
  );
  const body = {
    name,
    ...(apiKey ? { apiKey } : {}),
    ...(defaultModel ? { defaultModel } : {}),
    ...(providerSpecificData ? { providerSpecificData } : {}),
  };

  if (existing?.id) {
    const payload = await api(`/api/providers/${encodeURIComponent(existing.id)}`, {
      method: "PUT",
      body,
    });
    return payload?.connection ?? payload;
  }

  const payload = await api("/api/providers", {
    method: "POST",
    body: { provider, ...body },
  });
  return payload?.connection ?? payload;
}

async function setAlias(from, to) {
  await api("/api/settings/model-aliases", {
    method: "POST",
    body: { from, to },
  });
}

const glm = await upsertConnection({
  provider: "glm",
  name: "llm-runtime GLM Coding Plan",
  apiKey: glmApiKey,
  defaultModel: "glm-5.3",
});

const small = await upsertConnection({
  provider: "llama-cpp",
  name: "llm-runtime local small",
  defaultModel: "Qwen/Qwen2.5-7B-Instruct-GGUF:Q4_K_M",
  providerSpecificData: {
    baseUrl: "http://llm-small.llm-runtime.svc.cluster.local:8000/v1",
  },
});

const large = await upsertConnection({
  provider: "vllm",
  name: "llm-runtime local large",
  defaultModel: "Qwen2.5-72B-Instruct-AWQ",
  providerSpecificData: {
    baseUrl: "http://llm-large.llm-runtime.svc.cluster.local:8000/v1",
  },
});

const managed = [glm, small, large].filter((connection) => connection?.id);
if (managed.length !== 3) {
  throw new Error(`Expected 3 managed provider connections, got ${managed.length}`);
}

const selected = await api("/api/providers/test-batch", {
  method: "POST",
  body: {
    mode: "selected",
    connectionIds: managed.map((connection) => connection.id),
  },
});
if (selected?.summary?.failed > 0 || selected?.summary?.passed !== managed.length) {
  throw new Error(`Native provider validation failed: ${JSON.stringify(selected)}`);
}

for (const connection of [small, large]) {
  await api(`/api/providers/${encodeURIComponent(connection.id)}/sync-models?mode=import`, {
    method: "POST",
  });
}

const aliases = {
  "gpt-5.6-sol": "codex/gpt-5.6-sol",
  "gemini-subscription-pro": "agy/gemini-pro-agent",
  "gemini-subscription-auto": "agy/gemini-3.7-flash-medium",
  "glm-5.3": "glm/glm-5.3",
  "glm-5.3-flash": "glm/glm-5.3-flash",
//  "llm-small": "llama-cpp/Qwen/Qwen2.5-7B-Instruct-GGUF:Q4_K_M",
//  "llm-large": "vllm/Qwen2.5-72B-Instruct-AWQ",
};

for (const [from, to] of Object.entries(aliases)) {
  await setAlias(from, to);
}

const connections = await listConnections();
const oauth = {
  codex: connections.some((connection) => connection.provider === "codex" && connection.isActive),
  agy: connections.some((connection) => connection.provider === "agy" && connection.isActive),
};

const result = {
  configured: {
    glm: glm.id,
    small: small.id,
    large: large.id,
    aliases,
  },
  nativeOAuth: oauth,
  readyForFullRuntimeCheck: oauth.codex && oauth.agy,
};

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (!result.readyForFullRuntimeCheck) {
  process.stderr.write(
    "Native OAuth is not complete. Configure separate OmniRoute codex and agy sessions before switching RR.\n"
  );
}
