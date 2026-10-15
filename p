diff --git a/k8s/gitops/omniroute/alias-reconcile.mjs b/k8s/gitops/omniroute/alias-reconcile.mjs
--- a/k8s/gitops/omniroute/alias-reconcile.mjs
+++ b/k8s/gitops/omniroute/alias-reconcile.mjs
@@ -2,7 +2,7 @@
 // No sidecar, polling loop, or runtime restarts.
 import { readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
 import { createHash, randomUUID } from 'node:crypto';
-import yaml from 'js-yaml';
+import * as yaml from 'js-yaml';
 
 const desiredFile = process.env.OR_ALIASES_FILE || '/opt/alias-sync/config/aliases.yaml';
 const omnirouteUrl = (process.env.OR_BASE_URL || 'http://omniroute.llm-runtime.svc.cluster.local:20128').replace(/\/$/, '');

