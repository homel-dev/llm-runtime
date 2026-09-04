FROM node:24-bookworm-slim AS build

WORKDIR /opt/gateway
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi
COPY tsconfig.json ./
COPY src ./src
COPY test ./test
RUN npm run verify

FROM node:24-bookworm-slim AS antigravity
ARG ANTIGRAVITY_CLI_VERSION=1.1.26
ARG ANTIGRAVITY_CLI_BUILD=5550154686791680
ARG ANTIGRAVITY_CLI_SHA256=c47c0726266b3513660b7094bceceecbd03d8ae907786aa269c507ceb7e4ee54
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl tar gzip \
 && rm -rf /var/lib/apt/lists/* \
 && curl -fsSLo /tmp/agy.tar.gz "https://storage.googleapis.com/antigravity-public/antigravity-cli/${ANTIGRAVITY_CLI_VERSION}-${ANTIGRAVITY_CLI_BUILD}/linux-x64/cli_linux_x64.tar.gz" \
 && echo "${ANTIGRAVITY_CLI_SHA256}  /tmp/agy.tar.gz" | sha256sum -c - \
 && mkdir -p /opt/agy \
 && tar -xzf /tmp/agy.tar.gz -C /opt/agy \
 && test -x /opt/agy/antigravity \
 && install -m 0755 /opt/agy/antigravity /usr/local/bin/agy \
 && rm -rf /tmp/agy.tar.gz /opt/agy \
 && agy --version | grep -F "${ANTIGRAVITY_CLI_VERSION}" \
 && agy --help > /tmp/agy-help.txt \
 && grep -F -- "--input-format" /tmp/agy-help.txt >/dev/null \
 && grep -F -- "--output-format" /tmp/agy-help.txt >/dev/null \
 && grep -F -- "--json-schema" /tmp/agy-help.txt >/dev/null \
 && grep -F -- "--model" /tmp/agy-help.txt >/dev/null \
 && grep -F -- "--print-timeout" /tmp/agy-help.txt >/dev/null \
 && grep -F -- "--sandbox" /tmp/agy-help.txt >/dev/null \
 && rm -f /tmp/agy-help.txt

FROM node:24-bookworm-slim
ARG OPENAI_OAUTH_VERSION=2.0.0
COPY --from=antigravity /usr/local/bin/agy /usr/local/bin/agy
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates dbus-daemon gnome-keyring \
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
