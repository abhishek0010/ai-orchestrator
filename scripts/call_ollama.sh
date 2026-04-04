#!/usr/bin/env bash

# Expected parameters
ROLE=""
MODEL_OVERRIDE=""
PROMPT=""
CONTEXT_FILE=""
CONFIG_FILE="$HOME/.claude/llm-config.json"

while [[ "$#" -gt 0 ]]; do
    case $1 in
        --role) ROLE="$2"; shift ;;
        --model) MODEL_OVERRIDE="$2"; shift ;;
        --prompt) PROMPT="$2"; shift ;;
        --context-file) CONTEXT_FILE="$2"; shift ;;
        *) echo "Unknown parameter: $1"; exit 1 ;;
    esac
    shift
done

# Resolve model
SELECTED_MODEL="$MODEL_OVERRIDE"
if [ -z "$SELECTED_MODEL" ] && [ -n "$ROLE" ]; then
    if [ -f "$CONFIG_FILE" ]; then
        SELECTED_MODEL=$(jq -r ".models.\"$ROLE\"" "$CONFIG_FILE")
    fi
fi

# Fallback defaults if still empty
if [ -z "$SELECTED_MODEL" ] || [ "$SELECTED_MODEL" == "null" ]; then
    case $ROLE in
        coder) SELECTED_MODEL="qwen2.5-coder:14b-instruct-q4_K_M" ;;
        reviewer) SELECTED_MODEL="qwen2.5-coder:7b" ;;
        commit) SELECTED_MODEL="qwen2.5-coder:1.5b" ;;
        *) SELECTED_MODEL="qwen2.5-coder:7b" ;;
    esac
fi

if [ -z "$PROMPT" ]; then
    echo "Usage: $0 [--role <role> | --model <model>] --prompt <prompt> [--context-file <file>]"
    exit 1
fi

CONTEXT=""
if [ -n "$CONTEXT_FILE" ] && [ -f "$CONTEXT_FILE" ]; then
    CONTEXT=$(cat "$CONTEXT_FILE")
fi

# Build JSON payload safely using temporary files to avoid shell line length limits
TMP_PROMPT=$(mktemp)
TMP_CONTEXT=$(mktemp)
TMP_PAYLOAD=$(mktemp)

echo "$PROMPT" > "$TMP_PROMPT"
echo "$CONTEXT" > "$TMP_CONTEXT"

# Use jq to construct the final JSON
jq -n \
  --arg model "$SELECTED_MODEL" \
  --rawfile prompt "$TMP_PROMPT" \
  --rawfile context "$TMP_CONTEXT" \
  '{
    model: $model,
    messages: (
      if ($context != "") then [
        {role: "system", content: "You are an expert AI assistant. Output ONLY the response requested."},
        {role: "user", content: ("Context information:\n\n" + $context + "\n\n---\n\nBased on the context above, follow these instructions:\n" + $prompt)}
      ] else [
        {role: "system", content: "You are an expert AI assistant. Output ONLY the response requested."},
        {role: "user", content: $prompt}
      ] end
    ),
    stream: false
  }' > "$TMP_PAYLOAD"

# Call Ollama API
RESPONSE=$(curl -s -X POST http://localhost:11434/api/chat \
  -H "Content-Type: application/json" \
  -d @"$TMP_PAYLOAD")

# Cleanup
rm "$TMP_PROMPT" "$TMP_CONTEXT" "$TMP_PAYLOAD"

# Extract and output message content
echo "$RESPONSE" | jq -r '.message.content'
