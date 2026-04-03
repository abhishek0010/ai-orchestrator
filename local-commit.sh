#!/usr/bin/env bash

# Find the script's directory to locate call_ollama.sh
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OLLAMA_SCRIPT="$SCRIPT_DIR/call_ollama.sh"

# If the staging area is empty, stage all changes
if git diff --cached --quiet; then
    echo "💡 Staging area is empty. Staging all changes (git add -A)..."
    git add -A
fi

# Get the staged diff
DIFF=$(git diff --cached)

if [ -z "$DIFF" ]; then
    echo "❌ No changes to commit."
    exit 0
fi

# Save the diff to a temporary file
TMP_DIFF=$(mktemp)
echo "$DIFF" > "$TMP_DIFF"

echo "🤖 Ollama (qwen2.5-coder:1.5b) is analyzing the code and writing a commit message..."

PROMPT="Generate a concise Conventional Commit message based on this git diff. Output ONLY the commit message itself on a single line, nothing else. No markdown formatting."

# Call the helper script to query local Ollama
MESSAGE=$("$OLLAMA_SCRIPT" --model qwen2.5-coder:1.5b --prompt "$PROMPT" --context-file "$TMP_DIFF")

rm -f "$TMP_DIFF"

if [ -z "$MESSAGE" ] || [[ "$MESSAGE" == *"Error"* ]]; then
    echo "❌ Failed to call Ollama. Error output:"
    echo "$MESSAGE"
    exit 1
fi

echo -e "\n📝 Proposed commit message:"
echo -e "\033[1;32m$MESSAGE\033[0m\n"

# Prompt the user for confirmation
read -p "Commit with this message? (y/N) " confirm
if [[ "$confirm" =~ ^[Yy]$ ]]; then
    git commit -m "$MESSAGE"
    echo "✅ Committed successfully!"
else
    echo "🚫 Commit cancelled."
fi
