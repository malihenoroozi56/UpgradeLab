#!/usr/bin/env sh
# Builds the three deterministic fixture images used by the examples and the
# Docker-backed test suite. Run from the repository root.
set -eu

docker build -f fixtures/sample-app-v1/Dockerfile        -t upgradelab-sample-app:1.0.0        fixtures
docker build -f fixtures/sample-app-v2/Dockerfile        -t upgradelab-sample-app:2.0.0        fixtures
docker build -f fixtures/sample-app-v2-broken/Dockerfile -t upgradelab-sample-app:2.0.0-broken fixtures

echo "built upgradelab-sample-app:1.0.0, :2.0.0 and :2.0.0-broken"
