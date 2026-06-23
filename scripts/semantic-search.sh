#!/usr/bin/env bash
# Finds outcomes semantically similar to a query using stored Ollama embeddings.
# Usage: bash scripts/semantic-search.sh --query TEXT [--top-k N] [--min-similarity F] [--model MODEL]
# Output: matching outcomes.jsonl records as JSON Lines on stdout

set -euo pipefail

QUERY=""
TOP_K=5
MIN_SIMILARITY="0.7"
MODEL="mxbai-embed-large"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUTCOMES_FILE="$REPO_DIR/knowledge/outcomes.jsonl"
EMBEDDINGS_FILE="$REPO_DIR/knowledge/embeddings.jsonl"
OLLAMA_URL="http://localhost:11434"

while [[ "$#" -gt 0 ]]; do
    case "$1" in
        --query)          QUERY="$2"; shift 2 ;;
        --top-k)          TOP_K="$2"; shift 2 ;;
        --min-similarity) MIN_SIMILARITY="$2"; shift 2 ;;
        --model)          MODEL="$2"; shift 2 ;;
        *) echo "Unknown parameter: $1" >&2; exit 1 ;;
    esac
done

if [ -z "$QUERY" ]; then
    echo "Usage: $0 --query TEXT [--top-k N] [--min-similarity F] [--model MODEL]" >&2
    exit 1
fi

embed_query() {
    local payload
    payload=$(jq -cn --arg model "$MODEL" --arg prompt "$QUERY" \
        '{"model": $model, "prompt": $prompt}')

    local response
    response=$(curl -s --max-time 60 \
        -X POST "$OLLAMA_URL/api/embeddings" \
        -H "Content-Type: application/json" \
        -d "$payload")

    echo "$response" | jq -c '.embedding // empty'
}

main() {
    if ! curl -s --max-time 2 "$OLLAMA_URL/api/tags" >/dev/null 2>&1; then
        echo "ERROR: Ollama unavailable" >&2
        exit 1
    fi

    if [ ! -f "$EMBEDDINGS_FILE" ]; then
        echo "ERROR: $EMBEDDINGS_FILE not found — run embed-outcomes.sh first" >&2
        exit 1
    fi

    local query_embedding
    query_embedding=$(embed_query)

    if [ -z "$query_embedding" ]; then
        echo "ERROR: failed to embed query" >&2
        exit 1
    fi

    # Compute cosine similarities — pure python3, no numpy
    # $query_embedding is a JSON array string expanded by the shell before python3 runs
    local matches
    matches=$(python3 - <<PYEOF
import json, math, sys

query = json.loads("""$query_embedding""")
min_sim = float("$MIN_SIMILARITY")
top_k   = int("$TOP_K")

def cosine(va, vb):
    dot  = sum(a*b for a, b in zip(va, vb))
    norm = math.sqrt(sum(x**2 for x in va)) * math.sqrt(sum(x**2 for x in vb))
    return dot / norm if norm else 0.0

results = []
with open("$EMBEDDINGS_FILE") as f:
    for line in f:
        line = line.strip()
        if not line.startswith("{"):
            continue
        rec = json.loads(line)
        sim = cosine(query, rec["embedding"])
        if sim >= min_sim:
            results.append((rec["index"], sim))

results.sort(key=lambda x: x[1], reverse=True)
for idx, sim in results[:top_k]:
    print(f"{idx} {sim:.6f}")
PYEOF
)

    if [ -z "$matches" ]; then
        exit 0
    fi

    # Pull the corresponding outcomes.jsonl records by 0-based index
    local outcomes_lines
    outcomes_lines=$(grep '^{' "$OUTCOMES_FILE" 2>/dev/null || true)

    while IFS=' ' read -r idx _score; do
        echo "$outcomes_lines" | awk -v n="$idx" 'NR == n+1 {print; exit}'
    done <<< "$matches"
}

main
