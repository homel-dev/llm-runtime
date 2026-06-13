#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: $0 <small|medium|large>" >&2
  exit 2
fi

TIER="$1"
DEPLOY="llm-${TIER}"
NS="llm-runtime"

echo "== pod =="
kubectl -n "${NS}" get pod -l "app.kubernetes.io/name=${DEPLOY}" -o wide

echo
echo "== ready markers =="
kubectl -n "${NS}" logs "deploy/${DEPLOY}" --tail=300 | grep -E   'non-default args|enforce_eager|CompilationMode|CUDAGraph|Starting to load model|Time spent downloading weights|Loading weights took|Model loading took|init engine|Starting vLLM server|Application startup complete' || true

echo
echo "== local port check inside pod =="
kubectl -n "${NS}" exec "deploy/${DEPLOY}" -- bash -lc 'python3 - <<EOF
import socket
for host in ("127.0.0.1", "0.0.0.0"):
    s = socket.socket()
    s.settimeout(2)
    rc = s.connect_ex((host, 8000))
    print(f"{host}:8000 connect_ex={rc}")
    s.close()
EOF'
