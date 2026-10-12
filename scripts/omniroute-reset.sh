#!/usr/bin/env bash
set -euo pipefail
set +x

# One-time destructive reset of OmniRoute's own data PVC. Subscription auth
# PVCs and API-key Kubernetes Secrets are deliberately left untouched.
namespace="${LLM_RUNTIME_NAMESPACE:-llm-runtime}"
kubectl_bin="${KUBECTL:-kubectl}"
reset_pod="omniroute-storage-reset"

if [[ $# -ne 1 || "$1" != "--yes" ]]; then
  printf '%s\n' 'Usage: scripts/omniroute-reset.sh --yes' >&2
  printf '%s\n' 'WARNING: permanently deletes ALL files in llm-runtime/omniroute-data PVC.' >&2
  exit 2
fi

[[ "$namespace" =~ ^[a-z0-9]([-a-z0-9]*[a-z0-9])?$ ]] || { echo 'Invalid namespace' >&2; exit 2; }
command -v "$kubectl_bin" >/dev/null 2>&1 || { echo 'kubectl not found' >&2; exit 127; }
"$kubectl_bin" -n "$namespace" get deployment/omniroute pvc/omniroute-data >/dev/null
printf 'Resetting OmniRoute in context=%s namespace=%s, PVC=omniroute-data\n' \
  "$("$kubectl_bin" config current-context)" "$namespace"

# Ensure the SQLite writer has released the PVC before mounting it elsewhere.
"$kubectl_bin" -n "$namespace" scale deployment/omniroute --replicas=0
end=$((SECONDS + 180))
while true; do
  remaining="$("$kubectl_bin" -n "$namespace" get pods \
    -l app.kubernetes.io/name=omniroute \
    -o jsonpath='{.items[*].metadata.name}')"
  [[ -z "$remaining" ]] && break
  if ((SECONDS >= end)); then
    printf 'OmniRoute pods did not terminate: %s\n' "$remaining" >&2
    exit 1
  fi
  sleep 2
done

# The reset Pod has no mounts other than OmniRoute's database PVC.
"$kubectl_bin" -n "$namespace" delete "pod/$reset_pod" --ignore-not-found=true --wait=true >/dev/null
"$kubectl_bin" -n "$namespace" apply -f - <<EOF
apiVersion: v1
kind: Pod
metadata:
  name: $reset_pod
  namespace: $namespace
  labels:
    app.kubernetes.io/name: omniroute-storage-reset
spec:
  restartPolicy: Never
  automountServiceAccountToken: false
  securityContext:
    runAsNonRoot: true
    runAsUser: 1000
    runAsGroup: 1000
    fsGroup: 1000
    seccompProfile:
      type: RuntimeDefault
  containers:
    - name: wipe
      image: docker.io/library/python:3.12.12-alpine3.22
      imagePullPolicy: IfNotPresent
      command: [python, -c]
      args:
        - |
          from pathlib import Path
          import shutil
          root = Path('/app/data')
          if not root.is_dir():
              raise SystemExit('omniroute-data is not mounted')
          for entry in root.iterdir():
              if entry.is_dir() and not entry.is_symlink():
                  shutil.rmtree(entry)
              else:
                  entry.unlink()
          if any(root.iterdir()):
              raise SystemExit('omniroute-data is not empty after reset')
          print('omniroute-data PVC cleared')
      volumeMounts:
        - {name: data, mountPath: /app/data}
      securityContext:
        allowPrivilegeEscalation: false
        readOnlyRootFilesystem: true
        capabilities: {drop: [ALL]}
      resources:
        requests: {cpu: 10m, memory: 32Mi}
        limits: {cpu: 250m, memory: 256Mi}
  volumes:
    - name: data
      persistentVolumeClaim: {claimName: omniroute-data}
EOF

if ! "$kubectl_bin" -n "$namespace" wait \
  --for=jsonpath='{.status.phase}'=Succeeded "pod/$reset_pod" --timeout=180s; then
  "$kubectl_bin" -n "$namespace" describe "pod/$reset_pod" >&2 || true
  "$kubectl_bin" -n "$namespace" logs "pod/$reset_pod" >&2 || true
  echo 'OmniRoute remains scaled down; reset failed.' >&2
  exit 1
fi
"$kubectl_bin" -n "$namespace" logs "pod/$reset_pod"
"$kubectl_bin" -n "$namespace" delete "pod/$reset_pod" --wait=true >/dev/null

# Tokens minted by the erased database cannot be reused.
"$kubectl_bin" -n "$namespace" delete secret/omniroute-operator-token --ignore-not-found=true
# Keep omniroute-runtime as the initial password and encryption key for the
# newly initialized DB. Preserve unrelated Codex/Antigravity OAuth PVCs.
"$kubectl_bin" -n "$namespace" scale deployment/omniroute --replicas=1
"$kubectl_bin" -n "$namespace" rollout status deployment/omniroute --timeout=300s
printf '%s\n' 'OmniRoute storage reset completed; new database initialized.'
