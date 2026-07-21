FROM ghcr.io/kagent-dev/kagent/acp-sandbox-claude:0.10.0-beta7

USER root
WORKDIR /app

# copy entrypoint script and make it executable
COPY --chmod=755 docker-entrypoint.sh /

# Copy package files first for layer caching
COPY package.json ./
COPY tsconfig.json ./
COPY src/ src/

# Install all deps (including devDeps needed for tsc + jest), build, test, then prune
RUN npm install && npm run build && npm test && npm prune --omit=dev

RUN mkdir -p /home/agent/workspace && chown agent:agent /home/agent/workspace

USER agent

EXPOSE 8080

# Override the base image's acp-shim ENTRYPOINT — ACP is not used
ENTRYPOINT ["/docker-entrypoint.sh"]
