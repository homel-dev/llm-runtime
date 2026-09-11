import { createCodexCacheAffinityFetch } from "./codex-cache-affinity.js";

if (typeof globalThis.fetch === "function") {
  globalThis.fetch = createCodexCacheAffinityFetch(globalThis.fetch);
}
