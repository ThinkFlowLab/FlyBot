# FlyBot in a container (#352): one person, one instance. `dsh web` with the FlyBot core,
# social, tree and timeline packages of this checkout. Build it yourself; nothing is published.
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

# Stage 2: the runtime.
FROM ${NODE_IMAGE}
# DSH as pinned in the README; pnpm is what `dsh plugin` uses to manage the profile.
ARG DSH_VERSION=0.2.0-rc.2
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
USER node
WORKDIR /data
VOLUME ["/data"]
EXPOSE 3080
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 CMD ["node", "/opt/flybot/docker/healthcheck.mjs"]
ENTRYPOINT ["tini", "--", "node", "/opt/flybot/docker/entrypoint.mjs"]
