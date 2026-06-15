#!/usr/bin/env bash
# Generates Ollama embeddings for every record in knowledge/outcomes.jsonl.
# Usage: bash scripts/embed-outcomes.sh [--force] [--model MODEL]
# Output: knowledge/embeddings.jsonl — one {"index":N,"text":"...","embedding":[...]} per line

set -euo pipefail

MODEL="mxbai-embed-large"
FORCE=""
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUTCOMES_FILE="$REPO_DIR/knowledge/outcomes.jsonl"
EMBEDDINGS_FILE="$REPO_DIR/knowledge/embeddings.jsonl"
OLLAMA_URL="http://localhost:11434"

while [[ "$#" -gt 0 ]]; do
    case "$1" in
        --force) FORCE="true"; shift ;;
        --model) MODEL="$2"; shift 2 ;;
        *) echo "Unknown parameter: $1" >&2; exit 1 ;;
    esac
done

embed_record() {
    local index="$1"
    local text="$2"

    local payload
    payload=$(jq -cn --arg model "$MODEL" --arg prompt "$text" \
        '{"model": $model, "prompt": $prompt}')

    local response
    response=$(curl -s --max-time 60 \
        -X POST "$OLLAMA_URL/api/embeddings" \
        -H "Content-Type: application/json" \
        -d "$payload")

    local embedding
    embedding=$(echo "$response" | jq -c '.embedding // empty')

    if [ -z "$embedding" ]; then
        echo "WARNING: empty embedding for index $index — skipping" >&2
        return
    fi

    jq -cn \
        --argjson index "$index" \
        --arg text "$text" \
        --argjson embedding "$embedding" \
        '{"index": $index, "text": $text, "embedding": $embedding}' \
        >> "$EMBEDDINGS_FILE"
}

main() {
    # Silent exit if Ollama unavailable
    if ! curl -s --max-time 2 "$OLLAMA_URL/api/tags" >/dev/null 2>&1; then
        exit 0
    fi

    if [ ! -f "$OUTCOMES_FILE" ]; then
        exit 0
    fi

    local outcomes_count
    outcomes_count=$(grep -c '^{' "$OUTCOMES_FILE" 2>/dev/null || echo 0)

    if [ "$outcomes_count" -eq 0 ]; then
        exit 0
    fi

    # Skip already-embedded records unless --force
    local already_embedded=0
    if [ -f "$EMBEDDINGS_FILE" ] && [ -z "$FORCE" ]; then
        already_embedded=$(grep -c '^{' "$EMBEDDINGS_FILE" 2>/dev/null || echo 0)
    fi

    if [ "$already_embedded" -ge "$outcomes_count" ] && [ -z "$FORCE" ]; then
        exit 0
    fi

    # Truncate on --force
    if [ -n "$FORCE" ]; then
        already_embedded=0
        : > "$EMBEDDINGS_FILE"
    fi

    mkdir -p "$(dirname "$EMBEDDINGS_FILE")"

    local index=0
    while IFS= read -r line; do
        # Only process JSON object lines; skip '#' comments
        [[ "$line" =~ ^\{ ]] || continue

        if [ "$index" -lt "$already_embedded" ]; then
            index=$(( index + 1 ))
            continue
        fi

        local task task_type issues_joined text
        task=$(echo "$line" | jq -r '.task // ""')
        task_type=$(echo "$line" | jq -r '.task_type // ""')
        issues_joined=$(echo "$line" | jq -r '[.reviewer_issues[]?] | join(", ")')

        text="${task_type}: ${task}. Issues: ${issues_joined}"

        embed_record "$index" "$text"
        index=$(( index + 1 ))
    done < "$OUTCOMES_FILE"
}

main
