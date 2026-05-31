#!/usr/bin/env bash
# Refreshes knowledge/context-index.md with current repo state.
# Run manually after adding a new dependency or making an architectural decision.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INDEX="$REPO_DIR/knowledge/context-index.md"

if [ ! -f "$INDEX" ]; then
    echo "knowledge/context-index.md not found — nothing to update"
    exit 1
fi

echo "Updating knowledge/context-index.md..."

# Patch the repo row with the current branch and last-commit date
CURRENT_BRANCH=$(git -C "$REPO_DIR" branch --show-current 2>/dev/null || echo "unknown")
LAST_COMMIT=$(git -C "$REPO_DIR" log -1 --format="%ci" 2>/dev/null | cut -d' ' -f1 || echo "unknown")

# Update the _Update this file_ header timestamp
sed -i '' "s|^_Update this file.*|_Update this file when you add a new repo or discover a cross-project dependency. Last auto-refresh: ${LAST_COMMIT}_|" "$INDEX" 2>/dev/null || true

echo "  branch: $CURRENT_BRANCH"
echo "  last commit: $LAST_COMMIT"
echo "Done. Review and edit knowledge/context-index.md to add cross-repo dependencies."
