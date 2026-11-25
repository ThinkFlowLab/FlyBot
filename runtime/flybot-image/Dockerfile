# syntax=docker/dockerfile:1
#
# FlyBot FlyBot runtime image. Build context is the repository's runtime/ directory:
#   docker build -f runtime/flybot-image/Dockerfile -t flybot-workspace-flybot:local runtime
#
# Layers the pinned DS-Bot runtime, FlyBot integration and FlyBot social plugin onto
# DeepSeek Harness, with @flybot-workspace/flybot-runtime as the single DSH plugin entry
# (it calls createRuntime + the social façade). Matches the compose manager contract:
# USER 1000:1000, EXPOSE 8080, HEALTHCHECK, writable /data, no root entrypoint.
#
# This is a self-host build recipe. CI proves the image builds and starts.
# It is not a public release of a fully audited redistributable artifact.
# DSH transitive and base-image redistribution work is tracked as issue 3.

ARG NODE_IMAGE=node:24-bookworm-slim
# FlyBot pages served by each user's own DS-Bot (@flybot-workspace/web). CI and
# the deploy build pass the repository's flybot_workspace/static with
#   --build-context flybot-workspace-static=flybot_workspace/static
# which replaces this stage. A plain build still works: the plugin then has no
# pages and answers 404 for every page path.
FROM scratch AS flybot-workspace-static
COPY flybot-workspace-web/PAGES_NOT_BUNDLED.md /PAGES_NOT_BUNDLED.md

FROM ${NODE_IMAGE} AS build

ARG NPM_REGISTRY=https://registry.npmjs.org/
ARG DSH_VERSION=0.2.2-rc.1

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable \
    && npm config set registry "$NPM_REGISTRY" --global \
    && COREPACK_NPM_REGISTRY="$NPM_REGISTRY" pnpm config set registry "$NPM_REGISTRY" --global \
    && npm install -g "@deepseek-ai/dsh@${DSH_VERSION}" \
        --allow-scripts=@deepseek-ai/dsh-subprocess-local,node-pty,koffi,@google/genai,protobufjs,node-addon-require-builtin,node-addon-native-custom-loader,node-addon-require-builtin-linux-x64-gnu \
    && npm rebuild --prefix /usr/local/lib/node_modules/@deepseek-ai/dsh \
    && node -e "require('/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/node-addon-require-builtin')"

FROM ${NODE_IMAGE}

ARG NPM_REGISTRY=https://registry.npmjs.org/
ARG DSH_VERSION=0.2.2-rc.1

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates git curl \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable \
    && npm config set registry "$NPM_REGISTRY" --global \
    && COREPACK_NPM_REGISTRY="$NPM_REGISTRY" pnpm config set registry "$NPM_REGISTRY" --global

COPY --from=build /usr/local/ /usr/local/

# Preserve the repository layout so relative imports in the wrapper and
# flybot-social-host keep working. The profile uses link: to these paths.
COPY ds-bot-upstream/ds-bot /opt/flybot-workspace/runtime/ds-bot-upstream/ds-bot
COPY ds-bot-upstream/LICENSE /opt/licenses/ds-bot/LICENSE
COPY ds-bot-upstream/NOTICE /opt/licenses/ds-bot/NOTICE
COPY flybot/plugins/social /opt/flybot-workspace/runtime/flybot/plugins/social
COPY flybot/LICENSE /opt/licenses/flybot/LICENSE
COPY flybot/NOTICE /opt/licenses/flybot/NOTICE
COPY third_party/libreoffice-kit /opt/licenses/libreoffice-kit
COPY third_party/font-notices /opt/licenses/font-notices
COPY third_party/sharp-libvips /opt/licenses/sharp-libvips
COPY third_party/anthropic-sdk /opt/licenses/anthropic-sdk
COPY flybot-social-host /opt/flybot-workspace/runtime/flybot-social-host
COPY flybot-web-slots /opt/flybot-workspace/runtime/flybot-web-slots
COPY flybot-image /opt/flybot-workspace/runtime/flybot-image
RUN node /opt/flybot-workspace/runtime/flybot-image/native-ds-bot-overlay.mjs /opt/flybot-workspace/runtime/ds-bot-upstream/ds-bot \
    && node /opt/flybot-workspace/runtime/flybot-image/native-dsh-turn-overlay.mjs
COPY flybot-workspace-web /opt/flybot-workspace/runtime/flybot-workspace-web
COPY --from=flybot-workspace-static / /opt/flybot-workspace/runtime/flybot-workspace-web/pages/
RUN node --input-type=module -e 'import {writeChatAssetManifest} from "/opt/flybot-workspace/runtime/flybot-workspace-web/src/pages.js"; await writeChatAssetManifest("/opt/flybot-workspace/runtime/flybot-workspace-web/pages")'
# Place KaTeX and sharp-libvips notices beside the payloads they describe,
# in addition to /opt/licenses. Related tracking remains open: issue 3.
# The web profile (Playwright Codicon fonts) is installed later; the
# installer is run again after that step so those licenses travel with
# the font payloads too.
RUN node /opt/flybot-workspace/runtime/flybot-image/install-redistribution-notices.mjs --root / --notices /opt/licenses

# Materialize dsh native bindings under /usr/local (executable) so a noexec
# tmpfs /tmp at runtime still works. This RUN is as root, with a writable /tmp.
RUN node /opt/flybot-workspace/runtime/flybot-image/warm-native-bindings.cjs

# The wrapper and façade import the vendored trees by relative path. Node then
# resolves their package imports from that real path, not from the web profile,
# so ds-bot's dependencies and DSH peer packages must sit next to that tree.
RUN node -e "const v=process.env.DSH_VERSION||process.argv[1]; if(!/^[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z]+)*$/.test(v)) { console.error('invalid DSH version', v); process.exit(1) }" "$DSH_VERSION" \
    && npm ci --omit=dev --no-fund --no-audit --legacy-peer-deps --prefix /opt/flybot-workspace/runtime/ds-bot-upstream/ds-bot \
    && npm install --omit=dev --no-save --no-fund --no-audit --legacy-peer-deps --prefix /opt/flybot-workspace/runtime/ds-bot-upstream/ds-bot \
        "@deepseek-ai/cordis@${DSH_VERSION}" \
        "@deepseek-ai/dsh-llm@${DSH_VERSION}" \
        "@deepseek-ai/dsh-scope@${DSH_VERSION}" \
        "@deepseek-ai/dsh-tools@${DSH_VERSION}" \
        "@deepseek-ai/dsh-web@${DSH_VERSION}"

# Init an official DSH web profile, then pin our plugins as link: paths and
# drop a second ds-bot bundle so createRuntime runs once.
ENV DSH_HOME=/opt/dsh-template
RUN mkdir -p /opt/dsh-template \
    && dsh plugin --profile web add /opt/flybot-workspace/runtime/flybot-image/plugin \
    && node /opt/flybot-workspace/runtime/flybot-image/prepare-template.mjs \
    && pnpm --dir /opt/dsh-template/profiles/web install --prefer-offline --no-frozen-lockfile \
    && node /opt/flybot-workspace/runtime/flybot-image/prepare-template.mjs \
    && node /opt/flybot-workspace/runtime/flybot-image/install-redistribution-notices.mjs --root / --notices /opt/licenses \
    && mkdir -p /data /data/workspace /data/home \
    && chown -R 1000:1000 /opt/dsh-template /opt/flybot-workspace /opt/licenses /data /home/node

COPY --chmod=0755 flybot-image/entrypoint.sh /usr/local/bin/entrypoint.sh

ENV DSH_HOME=/data \
    DSH_PERMISSION_MODE=danger-full-access \
    DSH_TELEMETRY_DISABLED=1 \
    DSH_LISTEN_PORT=8080 \
    HOME=/data/home

USER 1000:1000
WORKDIR /data/workspace
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
# Check frequently while the web listener is starting. Once it is healthy,
# Docker resumes the normal probe interval.
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --start-interval=500ms --retries=5 \
    CMD ["sh", "/opt/flybot-workspace/runtime/flybot-image/healthcheck.sh"]

LABEL org.opencontainers.image.title="FlyBot FlyBot runtime" \
      org.opencontainers.image.description="Self-host FlyBot runtime: unmodified DS-Bot v0.3.6 plus the social host adapter, served by dsh web on 8080." \
      org.opencontainers.image.source="https://github.com/ThinkFlowLab/FlyBot" \
      org.opencontainers.image.licenses="MIT AND Apache-2.0"

# Pinned-image capability; manager checks before materializing HTTP task keys.
LABEL io.flybot-workspace.model-http="flybot-workspace.exact-http-task.v1"
