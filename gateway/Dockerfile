FROM node:24-bookworm-slim AS build

WORKDIR /opt/gateway
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi
COPY tsconfig.json ./
COPY src ./src
COPY test ./test
RUN npm run verify

FROM node:24-bookworm-slim AS antigravity
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*
USER node
ENV HOME=/home/node
RUN curl -fsSL https://antigravity.google/cli/install.sh | bash \
  && "$HOME/.local/bin/agy" --version

FROM node:24-bookworm-slim
ARG OPENAI_OAUTH_VERSION=2.0.0
COPY --from=antigravity /home/node/.local/bin/agy /usr/local/bin/agy
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g --ignore-scripts "openai-oauth@${OPENAI_OAUTH_VERSION}" \
 && command -v openai-oauth >/dev/null \
 && command -v agy >/dev/null \
 && id -u node | grep -qx 1000 \
 && mkdir -p /auth /antigravity-auth /etc/llm-runtime-gateway \
 && chown node:node /auth /antigravity-auth
WORKDIR /app
COPY --from=build /opt/gateway/dist ./dist
COPY antigravity-settings.json /etc/llm-runtime-gateway/antigravity-settings.json
USER 1000:1000
EXPOSE 8000
CMD ["node", "/app/dist/src/run.js"]
