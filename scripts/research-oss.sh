#!/usr/bin/env bash
# Daily OSS researcher: GitHub search → Ollama scoring → deep analysis → report → self-learning
# Usage: bash scripts/research-oss.sh [--dry-run] [--no-push]
# Globals: REPO_DIR derived from BASH_SOURCE[0]

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CALL_OLLAMA="$REPO_DIR/scripts/call_ollama.sh"
CAPTURE_OUTCOME="$REPO_DIR/scripts/capture-outcome.sh"
PROJECT_OVERVIEW="$REPO_DIR/.claude/context/project_overview.md"
MONITORING_DIR="$REPO_DIR/knowledge/github-monitoring"
TODAY="$(date +%Y-%m-%d)"
REPORT_FILE="$MONITORING_DIR/$TODAY.md"
DRY_RUN=""
NO_PUSH=""
TMP_DIR="$(mktemp -d)"

trap 'rm -rf "$TMP_DIR"' EXIT

while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --no-push) NO_PUSH=1; shift ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

log() { echo "[research] $*" >&2; }

# Log which model will actually be used for a role (reads llm-config.json cascade)
log_model() {
  local role="$1"
  local cfg="$REPO_DIR/llm-config.json"
  local cerebras free_model ollama_model fallback is_cloud_first

  is_cloud_first=$(jq -r --arg r "$role" \
    'if (.cloud_first_roles // []) | index($r) != null then "yes" else "no" end' "$cfg" 2>/dev/null || echo "no")
  cerebras=$(jq -r --arg r "$role" '.cerebras_api[$r] // empty' "$cfg" 2>/dev/null || echo "")
  free_model=$(jq -r --arg r "$role" '.free_api[$r] // empty' "$cfg" 2>/dev/null || echo "")
  ollama_model=$(jq -r --arg r "$role" '.models[$r] // "qwen3:8b"' "$cfg" 2>/dev/null || echo "qwen3:8b")
  fallback=$(jq -r --arg r "$role" '.fallback[$r] // empty' "$cfg" 2>/dev/null || echo "")

  if [ "$is_cloud_first" = "yes" ] && [ -n "$cerebras" ]; then
    log "    model cascade: Cerebras($cerebras) → FreeAPI($free_model) → Ollama($ollama_model) → Claude($fallback)"
  else
    log "    model cascade: FreeAPI($free_model) → Ollama($ollama_model) → Claude($fallback)"
  fi
}

# ─── Phase 1: GitHub API searches ────────────────────────────────────────────

log "Phase 1 — GitHub search"

QUERIES=(
  "context+compression+llm+proxy"
  "mcp+knowledge+graph+code"
  "code+intelligence+mcp+server"
  "fast+typescript+parser+compiler"
  "multi-agent+llm+orchestration+framework"
  "llm+agent+workflow+tool"
  "claude+code+plugin+extension"
)

CANDIDATES_FILE="$TMP_DIR/candidates.json"
echo "[]" > "$CANDIDATES_FILE"

CUTOFF_DATE="$(date -v-14d +%Y-%m-%d 2>/dev/null || date -d '14 days ago' +%Y-%m-%d 2>/dev/null || echo "")"

for q in "${QUERIES[@]}"; do
  sleep 2
  log "  searching: $q"
  RESULT=$(curl -sf --max-time 15 \
    -H "Accept: application/vnd.github.v3+json" \
    "https://api.github.com/search/repositories?q=${q}&sort=updated&order=desc&per_page=15" \
    2>/dev/null || echo '{"items":[]}')

  # Filter: not fork, 500+ stars, updated in last 14 days
  FILTER_JQ='.items[] | select(.fork == false) | select(.stargazers_count >= 500)'
  if [ -n "$CUTOFF_DATE" ]; then
    FILTER_JQ="$FILTER_JQ | select(.pushed_at >= \"$CUTOFF_DATE\")"
  fi
  FILTER_JQ="$FILTER_JQ | {full_name, description: (.description // \"\"), language: (.language // \"unknown\"), stars: .stargazers_count, pushed_at, topics: (.topics // [])}"

  NEW=$(echo "$RESULT" | jq -c "[$FILTER_JQ]" 2>/dev/null || echo "[]")

  # Merge and deduplicate by full_name
  MERGED=$(jq -sc '
    flatten |
    group_by(.full_name) |
    map(.[0])
  ' "$CANDIDATES_FILE" <(echo "$NEW") 2>/dev/null || cat "$CANDIDATES_FILE")
  echo "$MERGED" > "$CANDIDATES_FILE"
done

TOTAL=$(jq 'length' "$CANDIDATES_FILE")
log "Phase 1 done — $TOTAL unique candidates after filter"

if [ "$TOTAL" -eq 0 ]; then
  log "No candidates found. Exiting."
  exit 0
fi

# ─── Phase 2: Fast scoring via researcher role ────────────────────────────────

log "Phase 2 — Fast scoring (researcher role)"

SCORED_FILE="$TMP_DIR/scored.json"
echo "[]" > "$SCORED_FILE"

OVERVIEW_TEXT=""
if [ -f "$PROJECT_OVERVIEW" ]; then
  OVERVIEW_TEXT="$(cat "$PROJECT_OVERVIEW")"
fi

jq -c '.[]' "$CANDIDATES_FILE" | while IFS= read -r repo; do
  FULL_NAME=$(echo "$repo" | jq -r '.full_name')
  DESCRIPTION=$(echo "$repo" | jq -r '.description')
  STARS=$(echo "$repo" | jq -r '.stars')
  LANGUAGE=$(echo "$repo" | jq -r '.language')
  TOPICS=$(echo "$repo" | jq -r '.topics | join(", ")')

  log "  scoring: $FULL_NAME (⭐$STARS, $LANGUAGE)"
  log_model "researcher"

  # Fetch README excerpt (non-fatal)
  README_EXCERPT=$(curl -sf --max-time 10 \
    "https://raw.githubusercontent.com/$FULL_NAME/HEAD/README.md" 2>/dev/null \
    | head -80 || echo "(README unavailable)")

  SCORE_PROMPT="$(cat <<EOF
Repo: $FULL_NAME
Stars: $STARS
Language: $LANGUAGE
Topics: $TOPICS
Description: $DESCRIPTION
README excerpt:
$README_EXCERPT

Output exactly one line:
SCORE: N | REASON: one sentence explaining relevance to the project above
EOF
)"

  SCORE_TMP="$TMP_DIR/score_prompt_$(echo "$FULL_NAME" | tr '/' '_').txt"
  echo "$SCORE_PROMPT" > "$SCORE_TMP"

  RAW_SCORE=$("$CALL_OLLAMA" \
    --role researcher \
    --context-file "$PROJECT_OVERVIEW" \
    --prompt-file "$SCORE_TMP" 2>/dev/null || echo "SCORE: 0 | REASON: scoring failed")

  SCORE_NUM=$(echo "$RAW_SCORE" | grep -oE 'SCORE: [0-9]+' | grep -oE '[0-9]+' | head -1 || echo "0")
  REASON=$(echo "$RAW_SCORE" | sed 's/SCORE: [0-9]* | REASON: //' | head -1 || echo "")

  log "    → SCORE: $SCORE_NUM — $REASON"

  ENTRY=$(jq -nc \
    --argjson repo "$repo" \
    --argjson score "${SCORE_NUM:-0}" \
    --arg reason "$REASON" \
    '$repo + {score: $score, reason: $reason}')

  TMP_SCORED="$TMP_DIR/scored_tmp.json"
  jq --argjson entry "$ENTRY" '. + [$entry]' "$SCORED_FILE" > "$TMP_SCORED"
  mv "$TMP_SCORED" "$SCORED_FILE"
done

# Sort by score descending, keep top 3 with score >= 6
TOP_FILE="$TMP_DIR/top.json"
jq '[.[] | select(.score >= 6)] | sort_by(-.score) | .[0:3]' "$SCORED_FILE" > "$TOP_FILE"
SKIPPED_FILE="$TMP_DIR/skipped.json"
jq '[.[] | select(.score < 6)] | sort_by(-.score)' "$SCORED_FILE" > "$SKIPPED_FILE"

TOP_COUNT=$(jq 'length' "$TOP_FILE")
log "Phase 2 done — $TOP_COUNT repos scored >= 6 (top candidates)"

if [ "$TOP_COUNT" -eq 0 ]; then
  log "No relevant candidates found today."
  mkdir -p "$MONITORING_DIR"
  printf '# OSS Monitor Report — %s\n\nNo relevant projects found today (all scored below 6).\n' "$TODAY" > "$REPORT_FILE"
  exit 0
fi

# ─── Phase 3: Deep analysis of top candidates ────────────────────────────────

log "Phase 3 — Deep analysis (researcher-deep role)"

ANALYSES_DIR="$TMP_DIR/analyses"
mkdir -p "$ANALYSES_DIR"

jq -c '.[]' "$TOP_FILE" | while IFS= read -r repo; do
  FULL_NAME=$(echo "$repo" | jq -r '.full_name')
  DESCRIPTION=$(echo "$repo" | jq -r '.description')
  STARS=$(echo "$repo" | jq -r '.stars')
  LANGUAGE=$(echo "$repo" | jq -r '.language')
  TOPICS=$(echo "$repo" | jq -r '.topics | join(", ")')
  PUSHED=$(echo "$repo" | jq -r '.pushed_at | .[0:10]')
  DAYS_AGO=$(( ( $(date +%s) - $(date -j -f "%Y-%m-%d" "$PUSHED" +%s 2>/dev/null || date -d "$PUSHED" +%s 2>/dev/null || date +%s) ) / 86400 ))

  log "  deep analysis: $FULL_NAME"
  log_model "researcher-deep"

  README=$(curl -sf --max-time 15 \
    "https://raw.githubusercontent.com/$FULL_NAME/HEAD/README.md" 2>/dev/null \
    | head -200 || echo "(README unavailable)")

  STRUCTURE=$(curl -sf --max-time 15 \
    "https://api.github.com/repos/$FULL_NAME/git/trees/HEAD?recursive=1" 2>/dev/null \
    | jq -r '.tree[].path' 2>/dev/null | head -40 || echo "(structure unavailable)")

  DEEP_PROMPT="$(cat <<EOF
You are analyzing a GitHub repository to identify ideas and patterns worth adopting in ai-orchestrator.
The project context is in your context window.

IMPORTANT: Language does not matter. If the repo is Python, Go, Rust — we can port the logic to TypeScript/bash.
Evaluate the VALUE OF THE IDEA, not whether we can npm install it.
For ADOPT: describe what logic to port and into which file. For WATCH: describe what pattern to study.

Repository: $FULL_NAME
Stars: $STARS | Language: $LANGUAGE | Topics: $TOPICS | Updated: $DAYS_AGO days ago

Description: $DESCRIPTION

README (first 200 lines):
$README

File structure (first 40 paths):
$STRUCTURE

Write a structured analysis using EXACTLY this format:

### [$FULL_NAME](https://github.com/$FULL_NAME) ⭐ $STARS · $LANGUAGE · Updated: ${DAYS_AGO} days ago

**What it does:** One clear sentence.

**Problem it solves for ai-orchestrator:** Reference a specific file or pain point from the project context (e.g. "AgentLoop.ts has no verify→retry FSM" or "HeadroomBridge is optional and falls back silently").

**How to integrate:**
- File: \`src/core/xxx.ts\` or \`agents/xxx.md\` or \`scripts/xxx.sh\`
- Change: 2-3 lines of concrete description. Must not violate Known Constraints or Do Not Touch rules.

**Effort:** Quick (hours) / Medium (days) / Large (weeks)
**Risk:** Low / Medium / High — one reason

**Verdict: ADOPT** ✅ / **WATCH** 👀 / **SKIP** ❌ — one sentence justification.
EOF
)"

  DEEP_PROMPT_FILE="$TMP_DIR/deep_prompt_$(echo "$FULL_NAME" | tr '/' '_').txt"
  echo "$DEEP_PROMPT" > "$DEEP_PROMPT_FILE"

  ANALYSIS=$("$CALL_OLLAMA" \
    --role researcher-deep \
    --context-file "$PROJECT_OVERVIEW" \
    --prompt-file "$DEEP_PROMPT_FILE" 2>/dev/null || echo "Analysis unavailable for $FULL_NAME")

  VERDICT=$(echo "$ANALYSIS" | grep -oE 'Verdict: (ADOPT|WATCH|SKIP)' | head -1 | grep -oE 'ADOPT|WATCH|SKIP' || echo "WATCH")

  ANALYSIS_FILE="$ANALYSES_DIR/$(echo "$FULL_NAME" | tr '/' '_').md"
  echo "$ANALYSIS" > "$ANALYSIS_FILE"

  # Tag the repo entry with verdict for self-learning
  jq -c \
    --arg name "$FULL_NAME" \
    --arg verdict "$VERDICT" \
    'map(if .full_name == $name then . + {verdict: $verdict} else . end)' \
    "$TOP_FILE" > "$TMP_DIR/top_tmp.json"
  mv "$TMP_DIR/top_tmp.json" "$TOP_FILE"

  log "    → Verdict: $VERDICT"
done

# ─── Phase 4: Write report ────────────────────────────────────────────────────

log "Phase 4 — Writing report"

mkdir -p "$MONITORING_DIR"

# TL;DR from best ADOPT candidate
BEST=$(jq -r 'map(select(.verdict == "ADOPT")) | sort_by(-.score) | .[0].full_name // empty' "$TOP_FILE")
if [ -z "$BEST" ]; then
  BEST=$(jq -r 'sort_by(-.score) | .[0].full_name // empty' "$TOP_FILE")
fi

{
  printf '# OSS Monitor Report — %s\n\n' "$TODAY"
  printf '## TL;DR\n'
  if [ -n "$BEST" ] && [ -f "$ANALYSES_DIR/$(echo "$BEST" | tr '/' '_').md" ]; then
    # Extract the "What it does" line as TL;DR seed
    TLDR=$(grep -m1 '\*\*What it does:\*\*' "$ANALYSES_DIR/$(echo "$BEST" | tr '/' '_').md" | sed 's/\*\*What it does:\*\* //' || echo "")
    printf 'Top find today: **%s** — %s See full analysis below.\n' "$BEST" "$TLDR"
  else
    printf 'See projects analyzed below.\n'
  fi
  printf '\n---\n\n## Projects Analyzed\n\n'

  # Write each analysis
  jq -c 'sort_by(-.score)' "$TOP_FILE" | jq -c '.[]' | while IFS= read -r repo; do
    FULL_NAME=$(echo "$repo" | jq -r '.full_name')
    ANALYSIS_FILE="$ANALYSES_DIR/$(echo "$FULL_NAME" | tr '/' '_').md"
    if [ -f "$ANALYSIS_FILE" ]; then
      cat "$ANALYSIS_FILE"
      printf '\n\n---\n\n'
    fi
  done

  # Ranked recommendations table
  printf '## Ranked Recommendations\n\n'
  printf '| Priority | Project | Action | Why |\n'
  printf '|----------|---------|--------|-----|\n'
  RANK=1
  jq -c 'sort_by(-.score)' "$TOP_FILE" | jq -c '.[]' | while IFS= read -r repo; do
    FULL_NAME=$(echo "$repo" | jq -r '.full_name')
    VERDICT=$(echo "$repo" | jq -r '.verdict // "WATCH"')
    REASON=$(echo "$repo" | jq -r '.reason // ""')
    STARS=$(echo "$repo" | jq -r '.stars')
    printf '| %d | [%s](https://github.com/%s) (⭐%s) | %s | %s |\n' \
      "$RANK" "$FULL_NAME" "$FULL_NAME" "$STARS" "$VERDICT" "$REASON"
    RANK=$((RANK + 1))
  done

  printf '\n## Skipped\n'
  jq -c '.[]' "$SKIPPED_FILE" | while IFS= read -r repo; do
    FULL_NAME=$(echo "$repo" | jq -r '.full_name')
    SCORE=$(echo "$repo" | jq -r '.score')
    REASON=$(echo "$repo" | jq -r '.reason // "score below threshold"')
    printf -- '- **%s** (⭐%s, score %s): %s\n' \
      "$FULL_NAME" "$(echo "$repo" | jq -r '.stars')" "$SCORE" "$REASON"
  done
} > "$REPORT_FILE"

log "Report written: $REPORT_FILE"

# ─── Phase 5: Self-learning ───────────────────────────────────────────────────

log "Phase 5 — Self-learning (capture-outcome)"

if [ -x "$CAPTURE_OUTCOME" ]; then
  jq -c '.[]' "$TOP_FILE" | while IFS= read -r repo; do
    FULL_NAME=$(echo "$repo" | jq -r '.full_name')
    VERDICT=$(echo "$repo" | jq -r '.verdict // "WATCH"')
    STARS=$(echo "$repo" | jq -r '.stars')
    LANGUAGE=$(echo "$repo" | jq -r '.language')
    TOPICS=$(echo "$repo" | jq -r '.topics | join(",")')
    SCORE=$(echo "$repo" | jq -r '.score')

    # Map verdict to capture-outcome format
    CAPTURE_VERDICT="NEEDS_CHANGES"
    if [ "$VERDICT" = "ADOPT" ]; then
      CAPTURE_VERDICT="APPROVED"
    fi

    "$CAPTURE_OUTCOME" \
      --task "oss-research: $FULL_NAME" \
      --task-type "oss-research" \
      --files "$REPORT_FILE" \
      --verdict "$CAPTURE_VERDICT" \
      --model "researcher-deep" \
      --reviewer-issues "stars:$STARS,language:$LANGUAGE,topics:$TOPICS,score:$SCORE,verdict:$VERDICT" \
      2>/dev/null || true
  done
  log "Outcomes captured"
fi

# ─── Phase 6: Commit and push ─────────────────────────────────────────────────

if [ -n "$DRY_RUN" ]; then
  log "Dry run — skipping git commit/push"
  log "Report preview:"
  cat "$REPORT_FILE"
  exit 0
fi

log "Phase 6 — Commit and push"

cd "$REPO_DIR"
git add "$MONITORING_DIR/" 2>/dev/null || true

if git diff --cached --quiet; then
  log "Nothing to commit"
else
  git commit -m "chore(research): OSS monitor $TODAY" 2>/dev/null || true
  log "Committed"

  if [ -z "$NO_PUSH" ]; then
    git push 2>/dev/null || log "Push failed (no credentials?) — report is committed locally"
  fi
fi

log "Done. Report: $REPORT_FILE"
