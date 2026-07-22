FROM ghcr.io/kagent-dev/kagent/acp-sandbox-claude:0.10.0-beta7

USER root
WORKDIR /app

# copy entrypoint script and make it executable
COPY --chmod=755 docker-entrypoint.sh /docker-entrypoint.sh

# Install deps in a separate layer — only invalidated when package.json changes
COPY package.json /app/package.json
RUN --mount=type=cache,target=/root/.npm npm install

# Build and test — invalidated when src/ or tsconfig.json changes
COPY tsconfig.json /app/tsconfig.json
COPY src/ /app/src/
RUN npm run build && npm test && npm prune --omit=dev

RUN mkdir -p /data && chown -R agent:agent /data

USER agent

# Default HOME for non-Substrate contexts (local docker run, non-sandbox deployments).
# Substrate actors override this at launch time — see docker-entrypoint.sh.
ENV HOME=/data/home/agent

EXPOSE 80

# Override the base image's acp-shim ENTRYPOINT — ACP is not used
ENTRYPOINT ["/docker-entrypoint.sh"]
