export function createCodexCacheAffinityFetch(fetchImpl: typeof globalThis.fetch): typeof globalThis.fetch {
  const upstreamFetch = fetchImpl.bind(globalThis);
  return (async (input: Parameters<typeof globalThis.fetch>[0], init?: Parameters<typeof globalThis.fetch>[1]) => {
    try {
      const url = input instanceof Request ? input.url : input instanceof URL ? input.toString() : String(input);
      const target = new URL(url);
      const body = init?.body;
      if (target.hostname === "chatgpt.com" && target.pathname.endsWith("/responses") && typeof body === "string") {
        const parsed = JSON.parse(body) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          const key = (parsed as Record<string, unknown>).prompt_cache_key;
          if (typeof key === "string" && key.length > 0) {
            const headers = new Headers(input instanceof Request ? input.headers : undefined);
            new Headers(init?.headers).forEach((value, name) => headers.set(name, value));
            if (!headers.has("session-id")) headers.set("session-id", key);
            return upstreamFetch(input, { ...init, headers });
          }
        }
      }
    } catch {
      // Never make OAuth transport availability depend on cache-affinity decoration.
    }
    return upstreamFetch(input, init);
  }) as typeof globalThis.fetch;
}
