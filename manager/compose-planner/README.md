# Pure Compose command planner

Original independently authored FlyBot Deployment team planner and its27 tests, integrated unchanged. No old/private control-plane source is included. MIT per repository license.

`compose-command-planner.js` accepts trusted preregistered configuration plus a request restricted to an allowed action/instance/log tail. It produces spawn-style argument data with `shell:false`, never executes Docker or touches container state. `plan-stdio.mjs` is a fixed bounded JSON bridge for the Python **manager-side** adapter; it does not import child_process.

Run `node --test manager/compose-planner/compose-command-planner.test.js`. No npm dependencies. See ../../docs/RUNTIME_IMPLEMENTATION.md for authorization, idempotence and the unimplemented real execution/realpath/volume/log/recovery boundaries. This stateless planner does not replace durable jobs or prove a restart occurred.
