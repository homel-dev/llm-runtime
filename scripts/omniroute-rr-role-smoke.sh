#!/usr/bin/env bash
# Verifies RR's two actual Pi request protocols against the live OmniRoute Pod.
# This deliberately performs paid/limited inference; never runs during reconciliation.
set -euo pipefail
cd "$(dirname "$0")/.."
kubectl -n llm-runtime exec -i deployment/omniroute -c omniroute -- \
  node --input-type=module < scripts/omniroute-rr-role-smoke.mjs
