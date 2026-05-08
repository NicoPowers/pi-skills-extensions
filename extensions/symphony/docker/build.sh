#!/usr/bin/env bash
# Build and load Symphony worker images into sbx.
# Run from this directory: ./build.sh
set -euo pipefail

REGISTRY="${REGISTRY:-}"   # e.g. "myorg/" — leave empty for local-only images
TAG="${TAG:-v1}"

BASE="${REGISTRY}pi-symphony-base:${TAG}"
CODING="${REGISTRY}pi-symphony-coding:${TAG}"
QA="${REGISTRY}pi-symphony-qa:${TAG}"

echo "Building base image: $BASE"
docker build -f Dockerfile.base -t "$BASE" .

echo "Building coding image: $CODING"
docker build -f Dockerfile.coding -t "$CODING" .

echo "Building QA image: $QA"
docker build -f Dockerfile.qa -t "$QA" .

# Load into sbx (required when NOT pushing to Docker Hub).
# sbx only supports private templates from Docker Hub; use tar loading for other registries.
echo ""
echo "Loading images into sbx..."
for IMAGE in "$BASE" "$CODING" "$QA"; do
  NAME=$(echo "$IMAGE" | tr ':/' '--')
  docker image save "$IMAGE" -o "/tmp/${NAME}.tar"
  sbx template load "/tmp/${NAME}.tar"
  rm "/tmp/${NAME}.tar"
  echo "  Loaded: $IMAGE"
done

echo ""
echo "Done. Verify with: sbx template ls"
