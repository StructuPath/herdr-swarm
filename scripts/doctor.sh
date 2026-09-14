#!/usr/bin/env bash
# Read-only installation checks; do not resolve/create plugin state or contact
# a running Herdr session. Version probes use the same wrappers as fan-out.
set -uo pipefail
# shellcheck source=scripts/lib.sh
. "$(dirname "$0")/lib.sh"

failed=0
if require_node; then
	if node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)'; then
		printf 'OK Node %s\n' "$(node --version)"
	else
		echo 'FAIL Node >=20 is required.' >&2
		failed=1
	fi
else
	failed=1
fi

if git_version="$(git -C "$(dirname "$0")" --version 2>/dev/null)"; then
	printf 'OK %s\n' "$git_version"
	if ! version_ge "${git_version#git version }" 2.38; then
		echo 'WARN Git >=2.38 is recommended for squash-merge detection.' >&2
	fi
else
	echo 'FAIL Git is not available on PATH.' >&2
	failed=1
fi

printf 'Herdr binary: %s\n' "$(herdr_binary_path)"
if version_gate gated; then
	echo "OK Herdr fan-out version requirement (>=0.7.4; newest tested $HERDR_SWARM_MAX_TESTED)."
else
	echo 'FAIL Install a supported Herdr CLI or set HERDR_BIN_PATH to its absolute path.' >&2
	failed=1
fi

echo 'Agent prerequisites: check your selected preset binaries and authentication before fan-out.'
if command -v gh >/dev/null 2>&1; then
	echo 'Optional GitHub handoff: gh is installed; publish-pr/pr-status also require repository access.'
else
	echo 'Optional GitHub handoff: install gh for publish-pr/pr-status (ordinary publish does not need it).'
fi
echo 'This checks local prerequisites only; it does not exercise a Herdr session or start agents.'
exit "$failed"
