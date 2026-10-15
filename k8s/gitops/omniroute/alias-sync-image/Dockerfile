FROM node:22.16.0-alpine3.22
WORKDIR /opt/alias-sync
COPY package.json ./
RUN npm install --omit=dev --ignore-scripts --no-audit --no-fund \
  && npm cache clean --force
USER node
