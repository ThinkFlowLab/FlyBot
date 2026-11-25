# Agent API

An API key uses the assigned gateway instance ID in `ota_<instance_id>_<secret>`.
The platform forwards `/v1/gateway/` requests to that DS-Bot, where the plugin
verifies the key digest and runs the requested agent. A migrated volume keeps
its existing DS-Bot identity.

The owner manages keys through `agent-api/keys`, `agent-api/key-create`, and
`agent-api/key-revoke`. External requests use `agent-api/invoke` and
`agent-api/invocation` behind the gateway.
