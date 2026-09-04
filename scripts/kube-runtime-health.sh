#!/usr/bin/env bash
set -euo pipefail

tier="${1:?usage: $0 <small|medium|large>}"
exec ./scripts/gateway-check-models.sh "$tier" check
