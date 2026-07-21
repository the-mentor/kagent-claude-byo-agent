---
type: Playbook
title: Deployment & Operations
description: How to build, ship, and run claude-byo-agent — the Docker image built on kagent's acp-sandbox-claude base with a build-time test gate, the entrypoint that overrides the ACP shim, and Kubernetes deployment as a SandboxAgent CRD with the ANTHROPIC_API_KEY secret and port 80 readiness.
resource: Dockerfile
tags: [operations, deployment, docker, kubernetes, kagent]
---

# Deployment & Operations

## Docker image

The image builds on kagent's Claude sandbox base and self-tests during build (`Dockerfile`):

```dockerfile
FROM ghcr.io/kagent-dev/kagent/acp-sandbox-claude:0.10.0-beta7
USER root
WORKDIR /app
COPY --chmod=755 docker-entrypoint.sh /
COPY package.json ./
COPY tsconfig.json ./
COPY src/ src/
RUN npm install && npm run build && npm test && npm prune --omit=dev
RUN mkdir -p /home/agent/workspace && chown agent:agent /home/agent/workspace
USER agent
EXPOSE 80
ENTRYPOINT ["/docker-entrypoint.sh"]
```

Notable points:

- **Test gate.** `npm test` runs during build — the image will not build if the [tests](../testing.md) fail.
- **`npm prune --omit=dev`** drops dev dependencies after the build (replaced the deprecated `--production` flag in commit `e22c87c`).
- **Entrypoint override.** `docker-entrypoint.sh` is `exec node /app/dist/index.js`. It overrides the base image's ACP shim entrypoint because this agent speaks A2A, not ACP (see [architecture](../architecture/overview.md)). The script uses an absolute path so it is not cwd-dependent (commit `e7c720d`).
- **Port 80.** `EXPOSE 80` and the server listen on `:80` to satisfy kagent's `readyz` probe (commit `94909d3`).

## Kubernetes: SandboxAgent CRD

Deploy as `kind: SandboxAgent` (`kagent.dev/v1alpha2`) in the `kagent` namespace (`kagent-manifests/agent.yaml`):

```yaml
apiVersion: kagent.dev/v1alpha2
kind: SandboxAgent
metadata:
  name: claude-coding-agent
  namespace: kagent
spec:
  description: "Claude Code agent — persistent workspace per Substrate actor"
  type: BYO
  byo:
    deployment:
      image: <registry>/claude-byo-agent:latest
      cmd: /docker-entrypoint.sh
      env:
        - name: ANTHROPIC_API_KEY
          valueFrom:
            secretKeyRef:
              name: anthropic-credentials
              key: ANTHROPIC_API_KEY
```

- `cmd` points at `/docker-entrypoint.sh` explicitly. An optional `ANTHROPIC_BASE_URL` env var is commented in the manifest for non-default Anthropic endpoints.
- Each Substrate actor gets its own container and its own persistent `/home/agent/workspace`.

## Secret

`ANTHROPIC_API_KEY` is provided via a Kubernetes Secret. `kagent-manifests/secret.yaml` is a placeholder-only template (`<replace-with-real-key>`); do not commit real keys. Create it directly instead:

```bash
kubectl create secret generic anthropic-credentials \
  --from-literal=ANTHROPIC_API_KEY=sk-ant-... \
  -n kagent
```

## Running the container manually

```bash
docker run --rm -p 80:80 \
  -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
  --name claude-byo-test \
  claude-byo-agent:dev
```

Then verify discovery: `GET /.well-known/agent-card.json` should return the agent card, and `POST /` accepts A2A JSON-RPC (`message/send`, `message/stream`). See the [architecture overview](../architecture/overview.md) for the full A2A surface.

> Note: [`docs/design.md`](../../docs/design.md) still shows some pre-port-80 examples (port 8080, `cmd: ["node","dist/index.js"]`, a `test-local.sh` script that is not present). The commands above reflect the current code.
