#!/usr/bin/env sh
set -eu

IMAGE_NAME="${1:-perfectone/klee-coverage-tools:llvm18-lcov-v1}"
ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
DOCKERFILE="$ROOT_DIR/docker/perfectone-klee-coverage-tools/Dockerfile"

docker version
docker build -t "$IMAGE_NAME" -f "$DOCKERFILE" "$(dirname "$DOCKERFILE")"
docker image inspect "$IMAGE_NAME" >/dev/null
printf 'Prepared Docker image: %s\n' "$IMAGE_NAME"
