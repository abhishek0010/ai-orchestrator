#!/usr/bin/env bash

# Expected parameters
ROLE=""
MODEL_OVERRIDE=""
PROMPT=""
PROMPT_FILE=""
CONTEXT_FILE=""
# Load .env from project root (walk up from $PWD) — populates GROQ_API_KEY etc.
_DIR="$PWD"
while [ "$_DIR" != "/" ]; do
    if [ -f "$_DIR/.env" ]; then
        set -a
        # shellcheck disable=SC1091
        source "$_DIR/.env" 2>/dev/null || true
        set +a
        break
    fi
    _DIR=$(dirname "$_DIR")
done
unset _DIR

# Find config: project-level first (walk up from $PWD), then global
_DIR="$PWD"
CONFIG_FILE="$HOME/.claude/llm-config.json"
while [ "$_DIR" != "/" ]; do
    if [ -f "$_DIR/llm-config.json" ]; then
        CONFIG_FILE="$_DIR/llm-config.json"
        break
    fi
    _DIR=$(dirname "$_DIR")
done
unset _DIR

while [[ "$#" -gt 0 ]]; do
    case "$1" in
        --role) ROLE="$2"; shift 2 ;;
        --model) MODEL_OVERRIDE="$2"; shift 2 ;;
        --prompt) PROMPT="$2"; shift 2 ;;
        --prompt-file) PROMPT_FILE="$2"; shift 2 ;;
        --context-file) CONTEXT_FILE="$2"; shift 2 ;;
        *) echo "Unknown parameter: $1"; exit 1 ;;
    esac
done

# Resolve prompt from file if provided
if [ -n "$PROMPT_FILE" ] && [ -f "$PROMPT_FILE" ]; then
    PROMPT="$(cat "$PROMPT_FILE")"
fi

# Resolve model
SELECTED_MODEL="$MODEL_OVERRIDE"
if [ -z "$SELECTED_MODEL" ] && [ -n "$ROLE" ]; then
    if [ -f "$CONFIG_FILE" ]; then
        SELECTED_MODEL=$(jq -r --arg role "$ROLE" '.models[$role]' "$CONFIG_FILE")
    fi
fi

# Fallback defaults if still empty
if [ -z "$SELECTED_MODEL" ] || [ "$SELECTED_MODEL" = "null" ]; then
    case $ROLE in
        coder) SELECTED_MODEL="hf.co/bartowski/Qwen2.5-Coder-14B-Instruct-GGUF:IQ4_XS" ;;
        reviewer) SELECTED_MODEL="qwen2.5-coder:7b" ;;
        commit) SELECTED_MODEL="qwen2.5-coder:7b" ;;
        *) SELECTED_MODEL="qwen2.5-coder:7b" ;;
    esac
fi

# Resolve MAX_TOKENS from per-role config, fallback to 4096
MAX_TOKENS=4096
if [ -n "$ROLE" ] && [ -f "$CONFIG_FILE" ]; then
    _MT=$(jq -r --arg role "$ROLE" '(.max_tokens[$role] // .max_tokens.default // 4096)' "$CONFIG_FILE")
    MAX_TOKENS="${_MT:-4096}"
fi

# Detect cloud-first roles (planner/reviewer/debugger try Cerebras before Ollama)
IS_CLOUD_FIRST=false
if [ -n "$ROLE" ] && [ -f "$CONFIG_FILE" ]; then
    _IS_CF=$(jq -r --arg role "$ROLE" \
        'if (.cloud_first_roles // []) | index($role) != null then "true" else "false" end' \
        "$CONFIG_FILE")
    IS_CLOUD_FIRST="${_IS_CF:-false}"
fi
_CEREBRAS_ATTEMPTED=false

if [ -z "$PROMPT" ]; then
    echo "Usage: $0 [--role <role> | --model <model>] [--prompt <prompt> | --prompt-file <file>] [--context-file <file>]"
    exit 1
fi

CONTEXT=""
if [ -n "$CONTEXT_FILE" ] && [ -f "$CONTEXT_FILE" ]; then
    CONTEXT="$(cat "$CONTEXT_FILE")"
fi

# Shared temp files for prompt/context — used by all providers
TMP_PROMPT=$(mktemp)
TMP_CONTEXT=$(mktemp)
echo "$PROMPT" > "$TMP_PROMPT"
echo "$CONTEXT" > "$TMP_CONTEXT"

# Measure prompt size for token tracking (1 token ≈ 4 chars)
PROMPT_CHARS=$(wc -c < "$TMP_PROMPT" | tr -d ' ')

RESPONSE_CONTENT=""
RESPONSE=""

# _call_cerebras_api <model>
# Globals read:  TMP_PROMPT, TMP_CONTEXT, MAX_TOKENS, CEREBRAS_API_KEY
# Global set:    RESPONSE_CONTENT (non-empty string on success)
# Returns:       0 on success, 1 on failure
_call_cerebras_api() {
    local _cer_model="$1"
    local _tmp_payload
    _tmp_payload=$(mktemp)

    jq -n \
      --arg model "$_cer_model" \
      --rawfile prompt "$TMP_PROMPT" \
      --rawfile context "$TMP_CONTEXT" \
      --argjson max_tokens "$MAX_TOKENS" \
      'if ($context | rtrimstr("\n") | length) > 0 then {
        model: $model,
        max_tokens: $max_tokens,
        messages: [
          {role: "system", content: ("You are an expert AI assistant. Output ONLY the response requested.\n\n" + $context)},
          {role: "user", content: $prompt}
        ]
      } else {
        model: $model,
        max_tokens: $max_tokens,
        messages: [
          {role: "system", content: "You are an expert AI assistant. Output ONLY the response requested."},
          {role: "user", content: $prompt}
        ]
      } end' > "$_tmp_payload"

    local _cer_response
    _cer_response=$(curl -s --max-time 120 -X POST "https://api.cerebras.ai/v1/chat/completions" \
      -H "Content-Type: application/json" \
      -H "Authorization: Bearer ${CEREBRAS_API_KEY}" \
      -d @"$_tmp_payload")
    local _cer_exit=$?
    rm -f "$_tmp_payload"

    if [ "$_cer_exit" -eq 0 ]; then
        RESPONSE_CONTENT=$(echo "$_cer_response" | jq -r '.choices[0].message.content // empty')
    fi

    if [ -n "$RESPONSE_CONTENT" ]; then
        echo "[cerebras] ${_cer_model} — OK" >&2
        return 0
    else
        echo "[cerebras] no response — will try next" >&2
        return 1
    fi
}

# === CLOUD-FIRST: Cerebras before Ollama for planner/reviewer/debugger ===
if [ "$IS_CLOUD_FIRST" = "true" ] && [ -n "${CEREBRAS_API_KEY:-}" ]; then
    _CEREBRAS_ATTEMPTED=true

    _CER_MODEL=""
    if [ -n "$ROLE" ] && [ -f "$CONFIG_FILE" ]; then
        _CER_MODEL=$(jq -r --arg role "$ROLE" '.cerebras_api[$role] // empty' "$CONFIG_FILE")
    fi
    _CER_MODEL="${_CER_MODEL:-gpt-oss-120b}"

    _call_cerebras_api "$_CER_MODEL" || true
fi

# === OLLAMA (local) ===
if [ -z "$RESPONSE_CONTENT" ]; then
    TMP_PAYLOAD=$(mktemp)

    jq -n \
      --arg model "$SELECTED_MODEL" \
      --rawfile prompt "$TMP_PROMPT" \
      --rawfile context "$TMP_CONTEXT" \
      --argjson max_tokens "$MAX_TOKENS" \
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
        options: { num_predict: $max_tokens },
        stream: false
      }' > "$TMP_PAYLOAD"

    RESPONSE=$(curl -s -X POST http://localhost:11434/api/chat \
      -H "Content-Type: application/json" \
      -d @"$TMP_PAYLOAD")
    rm -f "$TMP_PAYLOAD"

    RESPONSE_CONTENT=$(echo "$RESPONSE" | jq -r '.message.content // empty')
fi

# === FREE API (FreeLLM routing) ===
if [ "${FREE_API_FALLBACK:-}" != "false" ] && [ -z "$RESPONSE_CONTENT" ]; then

    _FREE_URL=""
    if [ -n "${FREE_API_URL:-}" ]; then
        _FREE_URL="$FREE_API_URL"
    elif [ -f "$CONFIG_FILE" ]; then
        _FREE_URL=$(jq -r '.free_api_url // empty' "$CONFIG_FILE")
    fi
    _FREE_URL="${_FREE_URL:-http://localhost:3001/v1/chat/completions}"

    _FREE_MODEL=""
    if [ -n "$ROLE" ] && [ -f "$CONFIG_FILE" ]; then
        _FREE_MODEL=$(jq -r --arg role "$ROLE" '.free_api[$role] // empty' "$CONFIG_FILE")
    fi

    if [ -n "$_FREE_MODEL" ] && [ "$_FREE_MODEL" != "null" ]; then
        TMP_FREE_PAYLOAD=$(mktemp)
        jq -n \
          --arg model "$_FREE_MODEL" \
          --rawfile prompt "$TMP_PROMPT" \
          --rawfile context "$TMP_CONTEXT" \
          --argjson max_tokens "$MAX_TOKENS" \
          'if ($context | rtrimstr("\n") | length) > 0 then {
            model: $model,
            max_tokens: $max_tokens,
            messages: [
              {role: "system", content: ("You are an expert AI assistant. Output ONLY the response requested.\n\n" + $context)},
              {role: "user", content: $prompt}
            ]
          } else {
            model: $model,
            max_tokens: $max_tokens,
            messages: [
              {role: "system", content: "You are an expert AI assistant. Output ONLY the response requested."},
              {role: "user", content: $prompt}
            ]
          } end' > "$TMP_FREE_PAYLOAD"

        FREE_RESPONSE=$(curl -s --max-time 120 -X POST "$_FREE_URL" \
          -H "Content-Type: application/json" \
          -H "Authorization: Bearer ${FREELLM_API_KEY:-${FREE_API_KEY:-free}}" \
          -d @"$TMP_FREE_PAYLOAD")
        FREE_EXIT=$?
        rm -f "$TMP_FREE_PAYLOAD"

        if [ "$FREE_EXIT" -eq 0 ]; then
            RESPONSE_CONTENT=$(echo "$FREE_RESPONSE" | jq -r '.choices[0].message.content // empty')
        fi

        if [ -n "$RESPONSE_CONTENT" ]; then
            echo "[free-api] ${_FREE_MODEL} — OK" >&2
        else
            echo "[free-api] no response from ${_FREE_URL} (${_FREE_MODEL}) — will try next" >&2
        fi
    fi
fi

# === CEREBRAS (non-cloud-first fallback) ===
if [ "$_CEREBRAS_ATTEMPTED" = "false" ] && [ -n "${CEREBRAS_API_KEY:-}" ] && [ -z "$RESPONSE_CONTENT" ]; then

    _CER_MODEL=""
    if [ -n "$ROLE" ] && [ -f "$CONFIG_FILE" ]; then
        _CER_MODEL=$(jq -r --arg role "$ROLE" '.cerebras_api[$role] // empty' "$CONFIG_FILE")
    fi
    _CER_MODEL="${_CER_MODEL:-gpt-oss-120b}"

    _call_cerebras_api "$_CER_MODEL" || true
fi

# === FALLBACK: Claude API (paid, last resort) ===
if [ "${OLLAMA_FALLBACK:-}" != "false" ] && [ -z "$RESPONSE_CONTENT" ]; then

    FALLBACK_MODEL=""
    if [ -n "$ROLE" ] && [ -f "$CONFIG_FILE" ]; then
        FALLBACK_MODEL=$(jq -r --arg role "$ROLE" '.fallback[$role] // empty' "$CONFIG_FILE")
    fi

    if [ -n "$FALLBACK_MODEL" ]; then
        echo "[FALLBACK] using Claude (paid): $FALLBACK_MODEL" >&2

        if [ -z "${ANTHROPIC_API_KEY:-}" ]; then
            echo "[FALLBACK] ANTHROPIC_API_KEY is not set — cannot call Claude API" >&2
        else
            TMP_FALLBACK_PAYLOAD=$(mktemp)

            jq -n \
              --arg model "$FALLBACK_MODEL" \
              --rawfile prompt "$TMP_PROMPT" \
              --rawfile context "$TMP_CONTEXT" \
              --argjson max_tokens "$MAX_TOKENS" \
              'if ($context | rtrimstr("\n") | length) > 0 then {
                model: $model,
                max_tokens: $max_tokens,
                system: [
                  {
                    type: "text",
                    text: ("You are an expert AI assistant. Output ONLY the response requested.\n\n" + $context),
                    cache_control: { type: "ephemeral" }
                  }
                ],
                messages: [{ role: "user", content: $prompt }]
              } else {
                model: $model,
                max_tokens: $max_tokens,
                system: "You are an expert AI assistant. Output ONLY the response requested.",
                messages: [{ role: "user", content: $prompt }]
              } end' > "$TMP_FALLBACK_PAYLOAD"

            FALLBACK_RESPONSE=$(curl -s -X POST https://api.anthropic.com/v1/messages \
              -H "Content-Type: application/json" \
              -H "x-api-key: ${ANTHROPIC_API_KEY}" \
              -H "anthropic-version: 2023-06-01" \
              -H "anthropic-beta: prompt-caching-2024-07-31" \
              -d @"$TMP_FALLBACK_PAYLOAD")

            rm -f "$TMP_FALLBACK_PAYLOAD"

            RESPONSE_CONTENT=$(echo "$FALLBACK_RESPONSE" | jq -r '.content[0].text // empty')

            CACHE_CREATED=$(echo "$FALLBACK_RESPONSE" | jq -r '.usage.cache_creation_input_tokens // 0')
            CACHE_READ=$(echo "$FALLBACK_RESPONSE" | jq -r '.usage.cache_read_input_tokens // 0')
            if [ "$CACHE_READ" -gt 0 ] 2>/dev/null; then
                echo "[prompt-cache] HIT — ${CACHE_READ} tokens read from cache" >&2
            elif [ "$CACHE_CREATED" -gt 0 ] 2>/dev/null; then
                echo "[prompt-cache] MISS — ${CACHE_CREATED} tokens written to cache" >&2
            fi

            STATS_FILE="$HOME/.claude/token_stats.json"
            if [ ! -f "$STATS_FILE" ]; then
                echo '{"runs": []}' > "$STATS_FILE"
            fi
            FALLBACK_TIMESTAMP=$(date +"%Y-%m-%dT%H:%M:%S")
            TMP_FALLBACK_ENTRY=$(mktemp)
            TMP_FALLBACK_UPDATED=$(mktemp)
            jq -n \
                --arg ts "$FALLBACK_TIMESTAMP" \
                --arg role "${ROLE:-unknown}" \
                --arg model "$FALLBACK_MODEL" \
                '{ ts: $ts, role: $role, model: $model, fallback: true }' > "$TMP_FALLBACK_ENTRY"
            jq --slurpfile entry "$TMP_FALLBACK_ENTRY" '.runs += [$entry[0]]' "$STATS_FILE" > "$TMP_FALLBACK_UPDATED" \
                && mv "$TMP_FALLBACK_UPDATED" "$STATS_FILE" || true
            rm -f "$TMP_FALLBACK_ENTRY" "$TMP_FALLBACK_UPDATED"
        fi
    fi
fi

# Cleanup shared temp files
rm -f "$TMP_PROMPT" "$TMP_CONTEXT"

# Track token usage — best effort, never fail the script
TRACK_SCRIPT="$HOME/.claude/track_savings.sh"
if [ -f "$TRACK_SCRIPT" ]; then
    INPUT_TOKENS_REAL=$(echo "$RESPONSE" | jq -r '.prompt_eval_count // 0')
    OUTPUT_TOKENS_REAL=$(echo "$RESPONSE" | jq -r '.eval_count // 0')
    if [ "$INPUT_TOKENS_REAL" -eq 0 ] 2>/dev/null; then
        INPUT_TOKENS_REAL=$(( PROMPT_CHARS / 4 ))
    fi
    if [ "$OUTPUT_TOKENS_REAL" -eq 0 ] 2>/dev/null; then
        RESPONSE_CHARS=$(echo "$RESPONSE_CONTENT" | wc -c | tr -d ' ')
        OUTPUT_TOKENS_REAL=$(( RESPONSE_CHARS / 4 ))
    fi
    TASK_LABEL="${ROLE:-${SELECTED_MODEL}}"
    bash "$TRACK_SCRIPT" \
        --task "$TASK_LABEL" \
        --input-tokens "$INPUT_TOKENS_REAL" \
        --output-tokens "$OUTPUT_TOKENS_REAL" \
        --files "0" > /dev/null 2>&1 || true
fi

# Output message content
echo "$RESPONSE_CONTENT"
