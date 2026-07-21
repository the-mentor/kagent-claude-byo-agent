FROM ghcr.io/kagent-dev/kagent/acp-sandbox-claude

USER root
WORKDIR /app

# Copy package files first for layer caching
COPY package.json ./
COPY tsconfig.json ./
COPY src/ src/

# Install all deps (including devDeps needed for tsc + jest), build, test, then prune
RUN npm install && npm run build && npm test && npm prune --production

# Create the persistent workspace directory owned by the agent user
RUN mkdir -p /home/agent/workspace && chown agent:agent /home/agent/workspace

USER agent

EXPOSE 8080

# Override the base image's acp-shim ENTRYPOINT — ACP is not used
ENTRYPOINT ["node", "dist/index.js"]
