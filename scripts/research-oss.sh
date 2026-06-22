#!/usr/bin/env bash
# Daily OSS researcher: GitHub search → cooldown filter → Ollama scoring → deep analysis → retry if 0 ADOPT → report → self-learning
# Usage: bash scripts/research-oss.sh [--dry-run] [--no-push]

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CALL_OLLAMA="$REPO_DIR/scripts/call_ollama.sh"
CAPTURE_OUTCOME="$REPO_DIR/scripts/capture-outcome.sh"
PROJECT_OVERVIEW="$REPO_DIR/.claude/context/project_overview.md"
MONITORING_DIR="$REPO_DIR/knowledge/github-monitoring"
SEEN_FILE="$MONITORING_DIR/seen-repos.txt"
TODAY="$(date +%Y-%m-%d)"
TODAY_TS="$(date +%s)"
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

log_model() {
  local role="$1"
  local cfg="$REPO_DIR/llm-config.json"
  local is_cloud_first cerebras free_model ollama_model fallback

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

# Cooldown days per verdict: ADOPT→30, WATCH→14, SKIP→45
cooldown_days() {
  case "$1" in
    ADOPT) echo 30 ;;
    WATCH) echo 14 ;;
    SKIP)  echo 45 ;;
    *)     echo 14 ;;
  esac
}

# ─── Phase 1: GitHub search ───────────────────────────────────────────────────

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

  FILTER_JQ='.items[] | select(.fork == false) | select(.stargazers_count >= 500)'
  if [ -n "$CUTOFF_DATE" ]; then
    FILTER_JQ="$FILTER_JQ | select(.pushed_at >= \"$CUTOFF_DATE\")"
  fi
  FILTER_JQ="$FILTER_JQ | {full_name, description: (.description // \"\"), language: (.language // \"unknown\"), stars: .stargazers_count, pushed_at, topics: (.topics // [])}"

  NEW=$(echo "$RESULT" | jq -c "[$FILTER_JQ]" 2>/dev/null || echo "[]")

  MERGED=$(jq -sc 'flatten | group_by(.full_name) | map(.[0])' \
    "$CANDIDATES_FILE" <(echo "$NEW") 2>/dev/null || cat "$CANDIDATES_FILE")
  echo "$MERGED" > "$CANDIDATES_FILE"
done

log "Phase 1 done — $(jq 'length' "$CANDIDATES_FILE") unique candidates before cooldown"

# ─── Cooldown filter ──────────────────────────────────────────────────────────

SKIP_REPOS=()
if [ -f "$SEEN_FILE" ]; then
  log "Applying cooldown filter..."
  while IFS=$'\t' read -r name last_date verdict; do
    [ -z "$name" ] && continue
    cooldown=$(cooldown_days "$verdict")
    last_ts=$(date -j -f "%Y-%m-%d" "$last_date" +%s 2>/dev/null \
              || date -d "$last_date" +%s 2>/dev/null \
              || echo 0)
    days_since=$(( (TODAY_TS - last_ts) / 86400 ))

    if [ "$days_since" -lt "$cooldown" ]; then
      SKIP_REPOS+=("$name")
      log "  cooldown: $name (${verdict}, ${days_since}d / ${cooldown}d)"
    else
      log "  ready: $name (${verdict}, ${days_since}d since last — cooldown ${cooldown}d expired)"
    fi
  done < "$SEEN_FILE"
fi

if [ "${#SKIP_REPOS[@]}" -gt 0 ]; then
  SKIP_JSON=$(printf '%s\n' "${SKIP_REPOS[@]}" | jq -R . | jq -sc .)
  jq --argjson skip "$SKIP_JSON" \
    'map(select(.full_name as $n | $skip | index($n) == null))' \
    "$CANDIDATES_FILE" > "$TMP_DIR/filtered.json"
  mv "$TMP_DIR/filtered.json" "$CANDIDATES_FILE"
fi

TOTAL=$(jq 'length' "$CANDIDATES_FILE")
log "After cooldown: $TOTAL candidates ready for analysis"

if [ "$TOTAL" -eq 0 ]; then
  log "All candidates on cooldown. Exiting."
  exit 0
fi

# ─── Phase 2: Fast scoring ────────────────────────────────────────────────────

log "Phase 2 — Fast scoring (researcher)"

SCORED_FILE="$TMP_DIR/scored.json"
echo "[]" > "$SCORED_FILE"

jq -c '.[]' "$CANDIDATES_FILE" | while IFS= read -r repo; do
  FULL_NAME=$(echo "$repo" | jq -r '.full_name')
  DESCRIPTION=$(echo "$repo" | jq -r '.description')
  STARS=$(echo "$repo" | jq -r '.stars')
  LANGUAGE=$(echo "$repo" | jq -r '.language')
  TOPICS=$(echo "$repo" | jq -r '.topics | join(", ")')

  log "  scoring: $FULL_NAME (⭐$STARS, $LANGUAGE)"
  log_model "researcher"

  README=$(curl -sf --max-time 10 \
    "https://raw.githubusercontent.com/$FULL_NAME/HEAD/README.md" 2>/dev/null \
    | head -80 || echo "(unavailable)")

  SCORE_TMP="$TMP_DIR/score_$(echo "$FULL_NAME" | tr '/' '_').txt"
  cat > "$SCORE_TMP" <<EOF
Repo: $FULL_NAME
Stars: $STARS | Language: $LANGUAGE | Topics: $TOPICS
Description: $DESCRIPTION
README excerpt:
$README

Output exactly one line:
SCORE: N | REASON: one sentence explaining the specific idea or pattern valuable for this project
EOF

  RAW=$("$CALL_OLLAMA" --role researcher \
    --context-file "$PROJECT_OVERVIEW" \
    --prompt-file "$SCORE_TMP" 2>/dev/null \
    || echo "SCORE: 0 | REASON: scoring failed")

  SCORE=$(echo "$RAW" | grep -oE 'SCORE: [0-9]+' | grep -oE '[0-9]+' | head -1 || echo "0")
  SCORE=$(( SCORE > 10 ? 10 : SCORE ))
  SCORE=$(( SCORE < 0  ?  0 : SCORE ))
  REASON=$(echo "$RAW" | sed 's/SCORE: [0-9]* | REASON: //' | head -1 || echo "")

  log "    → SCORE: $SCORE — $REASON"

  ENTRY=$(jq -nc --argjson r "$repo" --argjson s "$SCORE" --arg reason "$REASON" \
    '$r + {score: $s, reason: $reason}')
  TMP_S="$TMP_DIR/scored_tmp.json"
  jq --argjson e "$ENTRY" '. + [$e]' "$SCORED_FILE" > "$TMP_S" && mv "$TMP_S" "$SCORED_FILE"
done

log "Phase 2 done"

# ─── Phase 3: Deep analysis (with retry) ─────────────────────────────────────

ANALYSES_DIR="$TMP_DIR/analyses"
mkdir -p "$ANALYSES_DIR"

# Function: deep-analyze a JSON array of repos, write verdicts back to a file
deep_analyze() {
  local input_file="$1"
  local label="${2:-batch}"

  log "Phase 3 — Deep analysis: $label ($(jq 'length' "$input_file") repos)"

  jq -c '.[]' "$input_file" | while IFS= read -r repo; do
    FULL_NAME=$(echo "$repo" | jq -r '.full_name')
    DESCRIPTION=$(echo "$repo" | jq -r '.description')
    STARS=$(echo "$repo" | jq -r '.stars')
    LANGUAGE=$(echo "$repo" | jq -r '.language')
    TOPICS=$(echo "$repo" | jq -r '.topics | join(", ")')
    PUSHED=$(echo "$repo" | jq -r '.pushed_at | .[0:10]')
    PUSHED_TS=$(date -j -f "%Y-%m-%d" "$PUSHED" +%s 2>/dev/null \
                || date -d "$PUSHED" +%s 2>/dev/null \
                || echo "$TODAY_TS")
    DAYS_AGO=$(( (TODAY_TS - PUSHED_TS) / 86400 ))

    log "  deep: $FULL_NAME"
    log_model "researcher-deep"

    README=$(curl -sf --max-time 15 \
      "https://raw.githubusercontent.com/$FULL_NAME/HEAD/README.md" 2>/dev/null \
      | head -200 || echo "(unavailable)")
    STRUCTURE=$(curl -sf --max-time 15 \
      "https://api.github.com/repos/$FULL_NAME/git/trees/HEAD?recursive=1" 2>/dev/null \
      | jq -r '.tree[].path' 2>/dev/null | head -40 || echo "(unavailable)")

    DEEP_TMP="$TMP_DIR/deep_$(echo "$FULL_NAME" | tr '/' '_').txt"
    cat > "$DEEP_TMP" <<EOF
You are analyzing a GitHub repository to find ideas worth porting into ai-orchestrator.
The project context is in your context window.

IMPORTANT: Language does not matter — Python, Go, Rust, Zig ideas are all fair game.
Evaluate the VALUE OF THE IDEA and whether the logic can be ported to TypeScript/bash.
For ADOPT: name the specific logic to port and the exact file to change.
For WATCH: describe what pattern to study and when it would become worth porting.
Do NOT violate Known Constraints or Do Not Touch rules from the project context.

Repository: $FULL_NAME
Stars: $STARS | Language: $LANGUAGE | Topics: $TOPICS | Updated: ${DAYS_AGO} days ago
Description: $DESCRIPTION

README (first 200 lines):
$README

File structure (first 40 paths):
$STRUCTURE

Write analysis using EXACTLY this format:

### [$FULL_NAME](https://github.com/$FULL_NAME) ⭐ $STARS · $LANGUAGE · Updated: ${DAYS_AGO} days ago

**What it does:** One clear sentence.

**Problem it solves for ai-orchestrator:** Reference a specific file or known pain point (e.g. "AgentLoop.ts has no verify→retry FSM").

**How to integrate:**
- File: \`src/core/xxx.ts\` or \`agents/xxx.md\` or \`scripts/xxx.sh\`
- Change: 2-3 lines of concrete description

**Effort:** Quick (hours) / Medium (days) / Large (weeks)
**Risk:** Low / Medium / High — one reason

**Verdict: ADOPT** ✅ / **WATCH** 👀 / **SKIP** ❌ — one sentence justification.
EOF

    ANALYSIS=$("$CALL_OLLAMA" --role researcher-deep \
      --context-file "$PROJECT_OVERVIEW" \
      --prompt-file "$DEEP_TMP" 2>/dev/null \
      || echo "Analysis unavailable for $FULL_NAME")

    VERDICT=$(echo "$ANALYSIS" | grep -oE 'Verdict: (ADOPT|WATCH|SKIP)' \
      | head -1 | grep -oE 'ADOPT|WATCH|SKIP' || echo "WATCH")

    echo "$ANALYSIS" > "$ANALYSES_DIR/$(echo "$FULL_NAME" | tr '/' '_').md"

    # Write verdict back to input_file
    jq --arg n "$FULL_NAME" --arg v "$VERDICT" \
      'map(if .full_name == $n then . + {verdict: $v} else . end)' \
      "$input_file" > "$input_file.tmp" && mv "$input_file.tmp" "$input_file"

    log "    → $VERDICT"
  done
}

# First pass: top 3 by score
TOP_FILE="$TMP_DIR/top.json"
jq '[.[] | select(.score >= 6)] | sort_by(-.score) | .[0:3]' "$SCORED_FILE" > "$TOP_FILE"
SCORED_BELOW="$TMP_DIR/below.json"
jq '[.[] | select(.score < 6)] | sort_by(-.score)' "$SCORED_FILE" > "$SCORED_BELOW"

TOP_COUNT=$(jq 'length' "$TOP_FILE")
if [ "$TOP_COUNT" -eq 0 ]; then
  log "No candidates scored >= 6. Exiting."
  mkdir -p "$MONITORING_DIR"
  printf '# OSS Monitor Report — %s\n\nNo relevant projects found today.\n' "$TODAY" > "$REPORT_FILE"
  exit 0
fi

deep_analyze "$TOP_FILE" "first pass"

# Retry if 0 ADOPT — take next 3 from scored list not yet analyzed
ADOPT_COUNT=$(jq '[.[] | select(.verdict == "ADOPT")] | length' "$TOP_FILE")
log "First pass: $ADOPT_COUNT ADOPT"

if [ "$ADOPT_COUNT" -eq 0 ]; then
  log "Phase 3 retry — 0 ADOPT, trying next batch"

  # Build set of already-analyzed full_names
  ANALYZED_NAMES=$(jq -c '[.[].full_name]' "$TOP_FILE")

  RETRY_FILE="$TMP_DIR/retry.json"
  jq --argjson seen "$ANALYZED_NAMES" \
    '[.[] | select(.full_name as $n | $seen | index($n) == null)] | sort_by(-.score) | .[0:3]' \
    "$SCORED_FILE" > "$RETRY_FILE"

  RETRY_COUNT=$(jq 'length' "$RETRY_FILE")
  if [ "$RETRY_COUNT" -gt 0 ]; then
    deep_analyze "$RETRY_FILE" "retry"

    # Merge retry results into TOP_FILE
    jq -sc 'flatten' "$TOP_FILE" "$RETRY_FILE" > "$TMP_DIR/merged.json"
    mv "$TMP_DIR/merged.json" "$TOP_FILE"

    ADOPT_COUNT=$(jq '[.[] | select(.verdict == "ADOPT")] | length' "$TOP_FILE")
    log "After retry: $ADOPT_COUNT ADOPT total"
  else
    log "No more candidates for retry"
  fi
fi

# ─── Update seen-repos.txt ────────────────────────────────────────────────────

update_seen() {
  local name="$1"
  local verdict="$2"
  mkdir -p "$MONITORING_DIR"
  touch "$SEEN_FILE"
  # Remove old entry for this repo (tab-separated)
  TMP_SEEN="$TMP_DIR/seen_tmp.txt"
  grep -v "^${name}	" "$SEEN_FILE" > "$TMP_SEEN" 2>/dev/null || true
  printf '%s\t%s\t%s\n' "$name" "$TODAY" "$verdict" >> "$TMP_SEEN"
  mv "$TMP_SEEN" "$SEEN_FILE"
}

# Update seen for all analyzed repos (top + retry if ran)
jq -c '.[]' "$TOP_FILE" | while IFS= read -r repo; do
  update_seen \
    "$(echo "$repo" | jq -r '.full_name')" \
    "$(echo "$repo" | jq -r '.verdict // "WATCH"')"
done

log "seen-repos.txt updated ($(wc -l < "$SEEN_FILE" | tr -d ' ') entries)"
log "  ADOPT→30d cooldown | WATCH→14d | SKIP→45d"

# ─── Phase 4: Write report ────────────────────────────────────────────────────

log "Phase 4 — Writing report"

mkdir -p "$MONITORING_DIR"

BEST=$(jq -r '[.[] | select(.verdict == "ADOPT")] | sort_by(-.score) | .[0].full_name // empty' "$TOP_FILE")
[ -z "$BEST" ] && BEST=$(jq -r 'sort_by(-.score) | .[0].full_name // empty' "$TOP_FILE")

{
  printf '# OSS Monitor Report — %s\n\n' "$TODAY"
  printf '## TL;DR\n'
  if [ -n "$BEST" ] && [ -f "$ANALYSES_DIR/$(echo "$BEST" | tr '/' '_').md" ]; then
    TLDR=$(grep -m1 '\*\*What it does:\*\*' "$ANALYSES_DIR/$(echo "$BEST" | tr '/' '_').md" \
      | sed 's/\*\*What it does:\*\* //' || echo "")
    printf 'Top find: **%s** — %s See full analysis below.\n' "$BEST" "$TLDR"
  else
    printf 'See projects analyzed below.\n'
  fi
  printf '\n---\n\n## Projects Analyzed\n\n'

  jq -c 'sort_by(-.score) | .[]' "$TOP_FILE" | while IFS= read -r repo; do
    FULL_NAME=$(echo "$repo" | jq -r '.full_name')
    ANALYSIS_FILE="$ANALYSES_DIR/$(echo "$FULL_NAME" | tr '/' '_').md"
    if [ -f "$ANALYSIS_FILE" ]; then
      cat "$ANALYSIS_FILE"
      printf '\n\n---\n\n'
    fi
  done

  printf '## Ranked Recommendations\n\n'
  printf '| Priority | Project | Action | Why |\n'
  printf '|----------|---------|--------|-----|\n'
  RANK=1
  jq -c 'sort_by(-.score) | .[]' "$TOP_FILE" | while IFS= read -r repo; do
    printf '| %d | [%s](https://github.com/%s) ⭐%s | %s | %s |\n' \
      "$RANK" \
      "$(echo "$repo" | jq -r '.full_name')" \
      "$(echo "$repo" | jq -r '.full_name')" \
      "$(echo "$repo" | jq -r '.stars')" \
      "$(echo "$repo" | jq -r '.verdict // "WATCH"')" \
      "$(echo "$repo" | jq -r '.reason // ""')"
    RANK=$((RANK + 1))
  done

  printf '\n## Skipped\n'
  jq -c '.[]' "$SCORED_BELOW" | while IFS= read -r repo; do
    printf -- '- **%s** ⭐%s (score %s): %s\n' \
      "$(echo "$repo" | jq -r '.full_name')" \
      "$(echo "$repo" | jq -r '.stars')" \
      "$(echo "$repo" | jq -r '.score')" \
      "$(echo "$repo" | jq -r '.reason // "below threshold"')"
  done
} > "$REPORT_FILE"

log "Report written: $REPORT_FILE"

# ─── Phase 5: Self-learning ───────────────────────────────────────────────────

if [ -x "$CAPTURE_OUTCOME" ]; then
  log "Phase 5 — Self-learning"
  jq -c '.[]' "$TOP_FILE" | while IFS= read -r repo; do
    FULL_NAME=$(echo "$repo" | jq -r '.full_name')
    VERDICT=$(echo "$repo" | jq -r '.verdict // "WATCH"')
    CAPTURE_VERDICT="NEEDS_CHANGES"
    [ "$VERDICT" = "ADOPT" ] && CAPTURE_VERDICT="APPROVED"

    "$CAPTURE_OUTCOME" \
      --task "oss-research: $FULL_NAME" \
      --task-type "oss-research" \
      --files "$REPORT_FILE" \
      --verdict "$CAPTURE_VERDICT" \
      --model "researcher-deep" \
      --reviewer-issues "stars:$(echo "$repo" | jq -r '.stars'),language:$(echo "$repo" | jq -r '.language'),score:$(echo "$repo" | jq -r '.score'),verdict:$VERDICT" \
      2>/dev/null || true
  done
  log "Outcomes captured"
fi

# ─── Phase 6: Commit and push ─────────────────────────────────────────────────

if [ -n "$DRY_RUN" ]; then
  log "Dry run — skipping commit/push"
  printf '\n=== REPORT ===\n'
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
    git push 2>/dev/null || log "Push failed — committed locally"
  fi
fi

log "Done. Report: $REPORT_FILE"
