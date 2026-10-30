The Project role switch answered `bot/not-found: Unknown endpoint project-role` on a host with a
member session: `channel.js` dispatched it and `store.js` implemented it, but authz's explicit
`TASK_ENDPOINTS` list never named it, so the gate refused before the handler ran. It is listed
there now, with a guard test that holds every endpoint the channel dispatches to a gate answer
that is not "unknown endpoint".
