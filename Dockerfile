# FlyBot in a container (#352): one person, one instance. `dsh web` with the FlyBot core,
# social, tree, workflow and timeline packages of this checkout. Build it yourself; nothing is published.
#   docker compose up -d --build        (see docs/docker.md)
# No keys or tokens are baked in: DEEPSEEK_API_KEY comes from the environment or from the
# credentials file on the data volume.

ARG NODE_IMAGE=node:24-bookworm-slim

# Stage 1: pack the packages exactly as a DSH profile installs them (the release tarballs).
FROM ${NODE_IMAGE} AS pack
WORKDIR /src
COPY . .
RUN node .github/scripts/check-pack.mjs /pkgs \
 && for tgz in /pkgs/*.tgz; do \
      dir="/out/$(basename "$tgz" .tgz)"; mkdir -p "$dir" && tar -xzf "$tgz" -C "$dir" --strip-components=1; \
    done
# The profile links these packages, and a `link:` installs none of a linked package's own
# dependencies. So ds-bot's runtime ones (the Feishu long-connection SDK, the Claude and Codex
# executor SDKs) go into its node_modules here, at the versions core/package-lock.json pins;
# core/.npmrc keeps the @deepseek-ai peers out, DSH provides those. The build stops if any
# image package still lacks a declared dependency.
RUN cd core \
 && npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
 && mv node_modules "$(echo /out/ds-bot-*)/node_modules" \
 && node --input-type=module -e "import { imagePackages, missingDependencies } from '/src/docker/profile.mjs'; const missing = missingDependencies(imagePackages('/out')); if (missing.length) { console.error('runtime dependencies missing from the image: ' + missing.join(', ')); process.exit(1) }"

# Stage 2: the runtime.
FROM ${NODE_IMAGE}
# DSH as pinned in the README; pnpm is what `dsh plugin` uses to manage the profile.
ARG DSH_VERSION=0.2.1-rc.2
ARG PNPM_VERSION=10.34.6
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git tini \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g --no-fund --no-audit "@deepseek-ai/dsh@${DSH_VERSION}" "pnpm@${PNPM_VERSION}" \
 && npm cache clean --force
COPY --from=pack /out/ /opt/flybot/packages/
COPY docker/ /opt/flybot/docker/
# The node image's unprivileged user (uid 1000). /data is the one volume: DSH home (profile,
# Bots, Sessions, credentials), the pnpm store and the Bots' workspace.
RUN mkdir -p /data && chown node:node /data
ENV DSH_HOME=/data HOME=/data NODE_ENV=production
ARG FLYBOT_SOURCE_REPOSITORY=zy95-12/FlyBot
ARG FLYBOT_REVISION=unknown
LABEL org.opencontainers.image.source="https://github.com/${FLYBOT_SOURCE_REPOSITORY}" \
      org.opencontainers.image.revision="${FLYBOT_REVISION}"
USER node
WORKDIR /data
VOLUME ["/data"]
EXPOSE 3080
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 CMD ["node", "/opt/flybot/docker/healthcheck.mjs"]
ENTRYPOINT ["tini", "--", "node", "/opt/flybot/docker/entrypoint.mjs"]
