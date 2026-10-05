#!/usr/bin/env bash
# Crea un .venv de Python en el proyecto con rembg instalado y precarga el
# modelo de segmentación BiRefNet-general.
# El server resuelve el binario en este orden: REMBG_BIN -> .venv/bin/rembg -> PATH.
#
# Para acelerar con GPU (CUDA) en vez de CPU, reemplazar la instalación por:
#   .venv/bin/pip install "rembg[gpu,cli]" onnxruntime-gpu
# y, para menos VRAM, usar el export fp16 del modelo (ver más abajo).
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -d .venv ]; then
  python3 -m venv .venv
fi
.venv/bin/pip install --upgrade pip
.venv/bin/pip install "rembg[cpu,cli]" onnxruntime

# --- Precarga del modelo de segmentación (BiRefNet-general) -----------------
# rembg resuelve el directorio de modelos en este orden (rembg/sessions/base.py):
#   U2NET_HOME -> REMBG_HOME -> $XDG_DATA_HOME/rembg -> ~/.rembg
# y espera el archivo como: <home>/models/birefnet-general/birefnet-general.onnx
# Lo bajamos desde un mirror de Hugging Face (mismo preprocesado: 1024x1024,
# media/desvío ImageNet) para no depender del release de GitHub.
# Para GPU podés cambiar la URL por .../onnx/model_fp16.onnx (mitad de tamaño).
# Omitir la descarga con: REMBG_SKIP_MODEL=1
if [ "${REMBG_SKIP_MODEL:-0}" != "1" ]; then
  if [ -n "${U2NET_HOME:-}" ]; then
    rembg_home="$U2NET_HOME"
  elif [ -n "${REMBG_HOME:-}" ]; then
    rembg_home="$REMBG_HOME"
  elif [ -n "${XDG_DATA_HOME:-}" ]; then
    rembg_home="$XDG_DATA_HOME/rembg"
  else
    rembg_home="$HOME/.rembg"
  fi

  model_dir="$rembg_home/models/birefnet-general"
  model_file="$model_dir/birefnet-general.onnx"
  model_url="https://huggingface.co/onnx-community/BiRefNet-ONNX/resolve/main/onnx/model.onnx"

  if [ -s "$model_file" ]; then
    echo "Modelo ya presente: $model_file"
  else
    mkdir -p "$model_dir"
    echo "Descargando BiRefNet-general (~928 MiB)..."
    ok=0
    if command -v curl >/dev/null 2>&1; then
      if curl -L --fail --progress-bar -o "$model_file.part" "$model_url"; then ok=1; fi
    elif command -v wget >/dev/null 2>&1; then
      if wget -O "$model_file.part" "$model_url"; then ok=1; fi
    else
      echo "Aviso: ni curl ni wget disponibles; se omite la descarga."
    fi
    if [ "$ok" = "1" ] && [ -s "$model_file.part" ]; then
      mv "$model_file.part" "$model_file"
      echo "Modelo guardado en: $model_file"
    else
      rm -f "$model_file.part"
      echo "Aviso: no se pudo descargar; rembg lo bajará solo al primer uso."
    fi
  fi
fi

echo
echo "rembg instalado en .venv/bin/rembg"
.venv/bin/rembg i --help >/dev/null && echo "OK: el binario responde."
