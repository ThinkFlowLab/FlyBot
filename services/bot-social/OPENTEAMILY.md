# OpenTeamily notes for the Bot Social snapshot

Bot Social is an **optional module** so collaboration protocols can be adapted
later. It is not a required third independently administered production service.

This change does not add management-server routes, workspace settings, or secret
handling for Bot Social. `runtime/flybot/plugins/social` still uses upstream
onboard APIs. Deploying `docker-compose.yml` / `start.sh` here is a developer
convenience only.

Tests: `npm ci` then `npm test` in this directory, using the snapshot lockfile,
with no real tokens. Do not commit `node_modules/`, SQLite data, or `.env`.
