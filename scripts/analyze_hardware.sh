#!/usr/bin/env bash
set -euo pipefail

# Script to analyze system hardware and suggest the best Ollama models

echo "Starting hardware analysis..."

OS_TYPE=$(uname -s)
TOTAL_RAM_GB=0
HAS_DEDICATED_GPU=false
GPU_VRAM_GB=0
CHIP_TYPE="Unknown"

# 1. Detect RAM and CPU
if [[ "$OS_TYPE" == "Darwin" ]]; then
    # macOS
    RAM_BYTES=$(sysctl -n hw.memsize)
    TOTAL_RAM_GB=$(( RAM_BYTES / 1024 / 1024 / 1024 ))
    
    CHIP_NAME=$(sysctl -n machdep.cpu.brand_string)
    if [[ "$CHIP_NAME" == *"Apple"* ]]; then
        CHIP_TYPE="Apple Silicon (Unified Memory)"
        # On Apple Silicon, unified memory acts as VRAM
        HAS_DEDICATED_GPU=true
        GPU_VRAM_GB=$TOTAL_RAM_GB
    else
        CHIP_TYPE="Intel Mac"
    fi

elif [[ "$OS_TYPE" == "Linux" ]]; then
    # Linux
    if command -v awk >/dev/null; then
        RAM_KB=$(grep MemTotal /proc/meminfo | awk '{print $2}')
        TOTAL_RAM_GB=$(( RAM_KB / 1024 / 1024 ))
    fi
    CHIP_TYPE=$(grep "model name" /proc/cpuinfo | head -n 1 | awk -F': ' '{print $2}')

    # Check for dedicated NVIDIA GPU
    if command -v nvidia-smi >/dev/null; then
        HAS_DEDICATED_GPU=true
        VRAM_MB=$(nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits | head -n 1 || echo "0")
        GPU_VRAM_GB=$(( VRAM_MB / 1024 ))
    fi
fi

echo "OS: $OS_TYPE"
echo "CPU: $CHIP_TYPE"
echo "RAM: ${TOTAL_RAM_GB} GB"

if [ "$HAS_DEDICATED_GPU" = true ] && [[ "$OS_TYPE" != "Darwin" ]]; then
    echo "Dedicated GPU detected (VRAM: ~${GPU_VRAM_GB} GB)"
elif [[ "$OS_TYPE" == "Darwin" ]] && [ "$HAS_DEDICATED_GPU" = true ]; then
    echo "Unified Memory architecture, available for VRAM: up to ~$(($GPU_VRAM_GB * 3 / 4)) GB (depending on system load)"
else
    echo "No dedicated (NVIDIA) GPU detected. Inference will run on CPU or integrated graphics."
fi

echo "======================================"

# Check which models are already installed
if command -v ollama >/dev/null; then
    # Get first column of ollama list, skip header
    INSTALLED_MODELS=$(ollama list | awk 'NR>1 {print $1}')
    
    echo "📋 Currently installed models:"
    if [ -z "$INSTALLED_MODELS" ]; then
        echo "  (None)"
    else
        echo "$INSTALLED_MODELS" | while read -r line; do
            echo "  - $line"
        done
    fi
else
    echo "⚠️ Ollama is not installed or not in PATH."
    INSTALLED_MODELS=""
fi

echo "======================================"
echo "🤖 Recommended models for your system:"

# Profile Logic
# 1. Base models for embeddings (always lightweight)
MODELS_TO_PULL=("nomic-embed-text")

if [[ "$OS_TYPE" == "Darwin" && "$HAS_DEDICATED_GPU" == true ]]; then
    # For Apple Silicon
    if [ "$TOTAL_RAM_GB" -ge 64 ]; then
         echo "[ULTRA] RAM >= 64GB: You can run 32B-70B Quantum 4 models."
         MODELS_TO_PULL+=("qwen2.5-coder:32b")
    elif [ "$TOTAL_RAM_GB" -ge 32 ]; then
         echo "[HIGH] RAM >= 32GB: You can run ~14B-32B models."
         MODELS_TO_PULL+=("qwen2.5-coder:14b-instruct-q4_K_M")
    elif [ "$TOTAL_RAM_GB" -ge 16 ]; then
         echo "[MEDIUM] RAM 16GB-31GB: 7B-8B models are optimal."
         MODELS_TO_PULL+=("qwen2.5-coder:7b" "llama3.1:8b")
    else
         echo "[LOW] RAM < 16GB: Lightweight models (1.5B-3B) are recommended to avoid swapping."
         MODELS_TO_PULL+=("qwen2.5-coder:1.5b")
    fi
else
    # For Linux/Windows(WSL) - consider discrete VRAM or total RAM for CPU inference
    if [ "$HAS_DEDICATED_GPU" = true ] && [ "$GPU_VRAM_GB" -ge 16 ]; then
         echo "[HIGH VRAM] VRAM >= 16GB: 14B+ models can fit entirely in VRAM."
         MODELS_TO_PULL+=("qwen2.5-coder:14b-instruct-q4_K_M")
    elif [ "$HAS_DEDICATED_GPU" = true ] && [ "$GPU_VRAM_GB" -ge 8 ]; then
         echo "[MEDIUM VRAM] VRAM 8GB-15GB: 7B-8B models are optimal."
         MODELS_TO_PULL+=("qwen2.5-coder:7b")
    else
         # Fallback to standard RAM or low VRAM scenarios
         if [ "$TOTAL_RAM_GB" -ge 32 ]; then
             echo "[CPU HIGH] RAM >= 32GB (No powerful GPU): Can run 14B-32B on CPU+RAM, but generation speed will be lower."
             MODELS_TO_PULL+=("qwen2.5-coder:7b" "qwen2.5-coder:14b-instruct-q4_K_M")
         elif [ "$TOTAL_RAM_GB" -ge 16 ]; then
             echo "[CPU MEDIUM] RAM 16-31GB (No powerful GPU): 7B-8B is best for CPU inference."
             MODELS_TO_PULL+=("qwen2.5-coder:7b")
         else
             echo "[LOW SPEC] RAM < 16GB: 1.5B-3B models are ideal."
             MODELS_TO_PULL+=("qwen2.5-coder:1.5b")
         fi
    fi
fi

# Check which recommended models are missing
MODELS_TO_DOWNLOAD=()
for model in "${MODELS_TO_PULL[@]}"; do
    if echo "$INSTALLED_MODELS" | grep -qE "^${model}(:latest)?$"; then
        echo "✅ [Installed] $model"
    else
        echo "❌ [Missing]   $model"
        MODELS_TO_DOWNLOAD+=("$model")
    fi
done

echo "======================================"

if [ ${#MODELS_TO_DOWNLOAD[@]} -eq 0 ]; then
    if [ ${#MODELS_TO_PULL[@]} -gt 0 ]; then
        echo "🎉 Great news! You already have all the optimal models for your hardware installed. No action needed."
    fi
else
    echo "📦 Models to download: ${MODELS_TO_DOWNLOAD[*]}"
    echo -n "Download missing models now? (y/n): "
    read choice
    if [ "$choice" == "y" ]; then
        for m in "${MODELS_TO_DOWNLOAD[@]}"; do
            ollama pull "$m"
        done
    fi
fi
