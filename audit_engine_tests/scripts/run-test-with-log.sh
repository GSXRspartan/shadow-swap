#!/usr/bin/env bash
# Run one local engine test while preserving Cargo's exit code in a durable log.
# This wrapper intentionally has no wallet, indexer, or network interaction.
set -o pipefail

log_path="$1"
shift

"$@" 2>&1 | tee "$log_path"
status=${PIPESTATUS[0]}
printf 'EXIT_CODE=%s\n' "$status" | tee "${log_path}.exit"
exit "$status"
