# Upstream Docker runtime includes /app/bin/omniroute.mjs, but its CLI
# needs tsx/esm (omitted from the runtime image; upstream issue #12152).
# Do not replace the upstream CLI or build a second CLI distribution.
ARG OMNIROUTE_VERSION=3.8.51
FROM docker.io/diegosouzapw/omniroute:${OMNIROUTE_VERSION}
USER root
WORKDIR /app
RUN npm install --no-save --legacy-peer-deps tsx@4.23.12 \
    && node /app/bin/omniroute.mjs --help >/dev/null
USER node
