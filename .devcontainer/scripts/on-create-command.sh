#!/usr/bin/env bash

set -euo pipefail

. "$(cd "$(dirname "$0")" && pwd)/library_scripts.sh"

ensure_node_env() {
  require_command pnpm

  if [[ -n "${PNPM_CONFIG_STORE_DIR:-}" ]]; then
    ensure_writable_dir "${PNPM_CONFIG_STORE_DIR}"
  fi

  if [[ -n "${NPM_REGISTRY:-}" ]]; then
    pnpm config set registry "${NPM_REGISTRY}"
  fi
}

main() {
  ensure_node_env
}

main "$@"
