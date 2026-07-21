#!/bin/sh

# Override HOME so Claude Code's session store (.claude/) and config (.claude.json)
# land in the Substrate durable dir (/data) and survive cold-boot resume.
# Substrate sets HOME from the container user's passwd entry (root → /root),
# overriding the Dockerfile ENV — so we re-set it here, inside the container,
# before exec-ing node so the process and all subprocesses inherit it.
export HOME=/data/home/agent
mkdir -p "$HOME"

exec node /app/dist/index.js
