#!/usr/bin/env bash
# Crea un .venv de Python en el proyecto con rembg instalado.
# El server resuelve el binario en este orden: REMBG_BIN -> .venv/bin/rembg -> PATH.
#
# Para acelerar con GPU (CUDA) en vez de CPU, reemplazar la última línea por:
#   .venv/bin/pip install "rembg[gpu,cli]" onnxruntime-gpu
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -d .venv ]; then
  python3 -m venv .venv
fi
.venv/bin/pip install --upgrade pip
.venv/bin/pip install "rembg[cpu,cli]" onnxruntime

echo
echo "rembg instalado en .venv/bin/rembg"
.venv/bin/rembg i --help >/dev/null && echo "OK: el binario responde."
