# Upstream Docker runtime includes /app/bin/omniroute.mjs, but its CLI
# needs tsx/esm (omitted from the runtime image; upstream issue #12152).
# Do not replace the upstream CLI or build a second CLI distribution.
ARG OMNIROUTE_VERSION=3.8.51
FROM docker.io/diegosouzapw/omniroute:${OMNIROUTE_VERSION}
USER root
WORKDIR /app
# Install ONLY the CLI loader in an isolated npm prefix. Installing from /app
# resolves the entire upstream dependency tree and can fail on unrelated packages.
# The symlink makes the official CLI's import("tsx/esm") resolve normally;
# tsx's own dependencies are resolved within the isolated prefix.
RUN mkdir -p /opt/omniroute-cli \
    && npm install --prefix /opt/omniroute-cli \
         --no-save --no-package-lock --ignore-scripts \
         tsx@4.23.12 \
    && test ! -e /app/node_modules/tsx \
    && ln -s /opt/omniroute-cli/node_modules/tsx /app/node_modules/tsx \
    && node /app/bin/omniroute.mjs --help >/dev/null
USER node
