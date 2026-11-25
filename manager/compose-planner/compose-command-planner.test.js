import assert from "node:assert/strict";
import test from "node:test";
import {
  ERROR_CODES,
  LIMITS,
  PLANNED_OPERATIONS,
  UNSUPPORTED_OPERATIONS,
  planComposeCommand,
} from "./compose-command-planner.js";

const INSTANCE_A = "inst01";
const INSTANCE_B = "inst02";

function trustedConfig(overrides = {}) {
  return {
    executable: "docker",
    projectPrefix: "ot",
    instances: {
      [INSTANCE_A]: {
        composeFile: "/var/lib/flybot-workspace/registry/inst01/compose.yaml",
        serviceName: "runtime",
        volumeName: "ot-inst01-data",
        imageRef: "example.invalid/flybot-workspace-runtime:pinned",
      },
      [INSTANCE_B]: {
        composeFile: "/var/lib/flybot-workspace/registry/inst02/compose.yaml",
        serviceName: "runtime",
        volumeName: "ot-inst02-data",
        imageRef: "example.invalid/flybot-workspace-runtime:pinned",
      },
    },
    ...overrides,
  };
}

function expectOk(result) {
  assert.equal(result.ok, true, result.ok ? "" : JSON.stringify(result.error));
  return result.plan;
}

function expectError(result, code) {
  assert.equal(result.ok, false, "expected failure, got a plan");
  assert.equal(result.error.code, code);
  assert.equal(typeof result.error.message, "string");
  assert.ok(result.error.message.length > 0);
}


function composeVerb(plan) {
  const fileIndex = plan.spawn.args.indexOf("--file");
  assert.ok(fileIndex >= 0, "plan must include --file");
  return plan.spawn.args[fileIndex + 2];
}

function assertSafeSpawn(plan) {
  assert.equal(plan.spawn.shell, false);
  assert.equal(plan.volumePolicy, "retain");
  assert.equal(plan.spawn.env, null);
  assert.ok(Array.isArray(plan.spawn.args));
  assert.equal(plan.spawn.args[0], "compose");
  const joined = plan.spawn.args.join("\0");
  for (const forbidden of ["down", "-v", "--volumes", "--rmi", "--build", "rm", "run", "exec"]) {
    assert.equal(
      plan.spawn.args.includes(forbidden),
      false,
      `plan must not contain ${forbidden}: ${plan.spawn.args.join(" ")}`,
    );
  }
  assert.equal(joined.includes("\n"), false);
  assert.ok(!plan.spawn.args.some((arg) => arg.includes(";") || arg.includes("|") || arg.includes("`")));
}

test("create plans compose create --no-build without starting", () => {
  const plan = expectOk(planComposeCommand(trustedConfig(), { operation: "create", instance_id: INSTANCE_A }));
  assert.deepEqual(plan.spawn, {
    executable: "docker",
    args: [
      "compose",
      "--project-name",
      "ot-inst01",
      "--file",
      "/var/lib/flybot-workspace/registry/inst01/compose.yaml",
      "create",
      "--no-build",
      "runtime",
    ],
    shell: false,
    cwd: null,
    env: null,
  });
  assertSafeSpawn(plan);
  assert.equal(plan.volumePolicy, "retain");
  assert.equal(plan.imageRef, "example.invalid/flybot-workspace-runtime:pinned");
});

test("start plans up -d --no-build using registry file and derived project name", () => {
  const plan = expectOk(planComposeCommand(trustedConfig(), { operation: "start", instance_id: INSTANCE_A }));
  assert.deepEqual(plan.spawn.args, [
    "compose",
    "--project-name",
    "ot-inst01",
    "--file",
    "/var/lib/flybot-workspace/registry/inst01/compose.yaml",
    "up",
    "-d",
    "--no-build",
    "runtime",
  ]);
  assertSafeSpawn(plan);
});

test("stop plans compose stop and never down or -v", () => {
  const plan = expectOk(planComposeCommand(trustedConfig(), { operation: "stop", instance_id: INSTANCE_A }));
  assert.deepEqual(plan.spawn.args.slice(-2), ["stop", "runtime"]);
  assert.equal(plan.spawn.args.includes("down"), false);
  assert.equal(plan.spawn.args.includes("-v"), false);
  assert.equal(plan.spawn.args.includes("--volumes"), false);
  assertSafeSpawn(plan);
});

test("restart plans compose restart and retains the volume", () => {
  const plan = expectOk(planComposeCommand(trustedConfig(), { operation: "restart", instance_id: INSTANCE_A }));
  assert.deepEqual(plan.spawn.args.slice(-2), ["restart", "runtime"]);
  assertSafeSpawn(plan);
});

test("inspect plans compose ps --all", () => {
  const plan = expectOk(planComposeCommand(trustedConfig(), { operation: "inspect", instance_id: INSTANCE_A }));
  assert.ok(plan.spawn.args.includes("ps"));
  assert.ok(plan.spawn.args.includes("--all"));
  assertSafeSpawn(plan);
});

test("logs uses default tail and --no-color as a separate argv entry", () => {
  const plan = expectOk(planComposeCommand(trustedConfig(), { operation: "logs", instance_id: INSTANCE_A }));
  const tailIndex = plan.spawn.args.indexOf("--tail");
  assert.ok(tailIndex >= 0);
  assert.equal(plan.spawn.args[tailIndex + 1], String(LIMITS.DEFAULT_TAIL));
  assert.ok(plan.spawn.args.includes("--no-color"));
  assertSafeSpawn(plan);
});

test("logs.tail accepts a bounded integer and a digits-only string", () => {
  const a = expectOk(
    planComposeCommand(trustedConfig(), { operation: "logs", instance_id: INSTANCE_A, opts: { tail: 20 } }),
  );
  assert.equal(a.spawn.args[a.spawn.args.indexOf("--tail") + 1], "20");
  const b = expectOk(
    planComposeCommand(trustedConfig(), { operation: "logs", instance_id: INSTANCE_A, opts: { tail: "7" } }),
  );
  assert.equal(b.spawn.args[b.spawn.args.indexOf("--tail") + 1], "7");
});

test("logs.tail rejects injection, out-of-range, and non-integers", () => {
  const badTails = ["100;rm -rf /", "1;down -v", "--tail", "0", 0, -1, 10_001, 1.5, "1e2", "0x10", "", null, [], {}];
  for (const tail of badTails) {
    expectError(
      planComposeCommand(trustedConfig(), { operation: "logs", instance_id: INSTANCE_A, opts: { tail } }),
      tail && typeof tail === "object" && !Array.isArray(tail)
        ? ERROR_CODES.INVALID_LOGS_OPTION
        : ERROR_CODES.INVALID_LOGS_OPTION,
    );
  }
});

test("unknown instance_id fails closed", () => {
  expectError(
    planComposeCommand(trustedConfig(), { operation: "start", instance_id: "missing0" }),
    ERROR_CODES.UNKNOWN_INSTANCE,
  );
});

test("instance_id is not read from the prototype chain", () => {
  const polluted = {};
  Object.setPrototypeOf(polluted, { inst01: { composeFile: "/tmp/evil/compose.yaml", serviceName: "x" } });
  expectError(
    planComposeCommand(
      { executable: "docker", instances: polluted },
      { operation: "start", instance_id: INSTANCE_A },
    ),
    ERROR_CODES.UNKNOWN_INSTANCE,
  );
});

test("rejects prototype-inherited and traversal instance ids", () => {
  const ids = [
    "__proto__",
    "constructor",
    "prototype",
    "../etc/passwd",
    "foo/bar",
    "..",
    ".",
    "inst01/../inst02",
    "-flag",
    "has space",
    "UPPER",
    "drop;down",
    "a".repeat(64),
  ];
  for (const instance_id of ids) {
    const result = planComposeCommand(trustedConfig(), { operation: "start", instance_id });
    assert.equal(result.ok, false, instance_id);
    assert.ok(
      result.error.code === ERROR_CODES.INVALID_INSTANCE_ID ||
        result.error.code === ERROR_CODES.UNKNOWN_INSTANCE,
      instance_id + " " + result.error.code,
    );
  }
});

test("untrusted request cannot choose image, command, mount, path, env, file, or project", () => {
  const keys = [
    "image",
    "imageRef",
    "command",
    "mount",
    "mounts",
    "path",
    "cwd",
    "env",
    "environment",
    "composeFile",
    "file",
    "projectName",
    "project",
    "executable",
    "shell",
    "args",
    "dockerfile",
    "network",
  ];
  for (const key of keys) {
    const request = { operation: "start", instance_id: INSTANCE_A, [key]: "attacker-value" };
    expectError(planComposeCommand(trustedConfig(), request), ERROR_CODES.UNTRUSTED_PARAMETER);
  }
});

test("request projectName and composeFile are ignored only because they are rejected, never applied", () => {
  const result = planComposeCommand(trustedConfig(), {
    operation: "start",
    instance_id: INSTANCE_A,
    projectName: "evil",
    composeFile: "/tmp/evil.yaml",
  });
  expectError(result, ERROR_CODES.UNTRUSTED_PARAMETER);
});

test("two registered instances never share the other compose file or project name", () => {
  const a = expectOk(planComposeCommand(trustedConfig(), { operation: "start", instance_id: INSTANCE_A }));
  const b = expectOk(planComposeCommand(trustedConfig(), { operation: "start", instance_id: INSTANCE_B }));
  assert.equal(a.projectName, "ot-inst01");
  assert.equal(b.projectName, "ot-inst02");
  assert.equal(a.composeFile.includes("inst01"), true);
  assert.equal(b.composeFile.includes("inst02"), true);
  assert.equal(a.composeFile === b.composeFile, false);
});

test("project name is derived from prefix + instance_id, not from a request field", () => {
  const plan = expectOk(planComposeCommand(trustedConfig({ projectPrefix: "acme" }), { operation: "stop", instance_id: INSTANCE_B }));
  assert.equal(plan.projectName, "acme-inst02");
  assert.equal(plan.spawn.args[plan.spawn.args.indexOf("--project-name") + 1], "acme-inst02");
});

test("unsupported contract operations return stable unsupported and no spawn", () => {
  assert.deepEqual(UNSUPPORTED_OPERATIONS, ["backup", "restore", "upgrade", "reclaim", "purge"]);
  for (const operation of UNSUPPORTED_OPERATIONS) {
    const result = planComposeCommand(trustedConfig(), { operation, instance_id: INSTANCE_A });
    expectError(result, ERROR_CODES.UNSUPPORTED);
    assert.equal("plan" in result, false);
  }
});

test("unknown or destructive-looking operations are unknown_operation, not planned", () => {
  const ops = ["down", "down -v", "rm", "run", "exec", "kill", "build", "purge;down", "", "START"];
  for (const operation of ops) {
    expectError(
      planComposeCommand(trustedConfig(), { operation, instance_id: INSTANCE_A }),
      ERROR_CODES.UNKNOWN_OPERATION,
    );
  }
});

test("registry composeFile must be an absolute POSIX path without traversal", () => {
  const badPaths = [
    "compose.yaml",
    "./compose.yaml",
    "/var/lib/flybot-workspace/../etc/compose.yaml",
    "/var/lib/flybot-workspace/registry/./compose.yaml",
    "//var/lib/flybot-workspace/compose.yaml",
    "/var/lib/flybot-workspace/compose.yaml\n/etc/passwd",
  ];
  for (const composeFile of badPaths) {
    expectError(
      planComposeCommand(
        trustedConfig({
          instances: {
            [INSTANCE_A]: { composeFile, serviceName: "runtime" },
          },
        }),
        { operation: "start", instance_id: INSTANCE_A },
      ),
      ERROR_CODES.INVALID_CONFIG,
    );
  }
});

test("invalid trusted executable or prefix fails closed", () => {
  expectError(
    planComposeCommand(trustedConfig({ executable: "sh" }), { operation: "start", instance_id: INSTANCE_A }),
    ERROR_CODES.INVALID_CONFIG,
  );
  expectError(
    planComposeCommand(trustedConfig({ executable: "/bin/sh" }), { operation: "start", instance_id: INSTANCE_A }),
    ERROR_CODES.INVALID_CONFIG,
  );
  expectError(
    planComposeCommand(trustedConfig({ projectPrefix: "../x" }), { operation: "start", instance_id: INSTANCE_A }),
    ERROR_CODES.INVALID_CONFIG,
  );
});

test("absolute trusted docker path is accepted when it ends with /docker", () => {
  const plan = expectOk(
    planComposeCommand(trustedConfig({ executable: "/usr/bin/docker" }), {
      operation: "inspect",
      instance_id: INSTANCE_A,
    }),
  );
  assert.equal(plan.spawn.executable, "/usr/bin/docker");
  assert.equal(plan.spawn.shell, false);
});

test("request cannot override executable via prototype or unexpected type", () => {
  expectError(planComposeCommand(trustedConfig(), null), ERROR_CODES.INVALID_REQUEST);
  expectError(planComposeCommand(null, { operation: "start", instance_id: INSTANCE_A }), ERROR_CODES.INVALID_CONFIG);
  expectError(planComposeCommand(trustedConfig(), ["start", INSTANCE_A]), ERROR_CODES.INVALID_REQUEST);
});

test("planned operation set matches the first-path compose actions", () => {
  assert.deepEqual(PLANNED_OPERATIONS, ["create", "start", "stop", "restart", "inspect", "logs"]);
});

test("shell is always false and cwd comes only from trusted config", () => {
  const withCwd = expectOk(
    planComposeCommand(trustedConfig({ cwd: "/var/lib/flybot-workspace/registry/inst01" }), {
      operation: "create",
      instance_id: INSTANCE_A,
    }),
  );
  assert.equal(withCwd.spawn.shell, false);
  assert.equal(withCwd.spawn.cwd, "/var/lib/flybot-workspace/registry/inst01");
  expectError(
    planComposeCommand(trustedConfig({ cwd: "/var/lib/flybot-workspace/../tmp" }), {
      operation: "create",
      instance_id: INSTANCE_A,
    }),
    ERROR_CODES.INVALID_CONFIG,
  );
});

test("error objects do not include spawn plans or secret-like fields", () => {
  const result = planComposeCommand(trustedConfig(), { operation: "purge", instance_id: INSTANCE_A });
  expectError(result, ERROR_CODES.UNSUPPORTED);
  assert.equal(JSON.stringify(result).includes("spawn"), false);
  assert.equal(JSON.stringify(result).includes("token"), false);
});

test("restart is one spawn whose only compose verb is restart, never up or stop/start", () => {
  const result = planComposeCommand(trustedConfig(), { operation: "restart", instance_id: INSTANCE_A });
  const plan = expectOk(result);
  assert.equal(result.ok, true);
  assert.equal(Array.isArray(result), false);
  assert.equal(Array.isArray(plan.spawn), false);
  assert.equal(composeVerb(plan), "restart");
  assert.equal(plan.spawn.args.filter((arg) => arg === "restart").length, 1);
  for (const verb of ["up", "stop", "start", "create", "down"]) {
    assert.equal(plan.spawn.args.includes(verb), false, `restart plan must not include ${verb}`);
  }
  assert.equal(plan.volumePolicy, "retain");
  assertSafeSpawn(plan);
  assert.deepEqual(plan.spawn.args, [
    "compose",
    "--project-name",
    "ot-inst01",
    "--file",
    "/var/lib/flybot-workspace/registry/inst01/compose.yaml",
    "restart",
    "runtime",
  ]);
});

test("planner is stateless and does not implement revision or operation_id idempotency", () => {
  const callerMetadata = {
    operation_id: "op-new-key",
    revision: 7,
    expected_revision: 7,
    desired: "running",
    observed: "pending",
    observed_revision: 6,
  };
  const restartA = expectOk(
    planComposeCommand(trustedConfig(), { operation: "restart", instance_id: INSTANCE_A, ...callerMetadata }),
  );
  const restartB = expectOk(
    planComposeCommand(trustedConfig(), {
      operation: "restart",
      instance_id: INSTANCE_A,
      operation_id: "op-same-key-retry",
      revision: 99,
      desired: "running",
      observed_revision: 99,
    }),
  );
  const restartBare = expectOk(
    planComposeCommand(trustedConfig(), { operation: "restart", instance_id: INSTANCE_A }),
  );
  assert.deepEqual(restartA.spawn, restartB.spawn);
  assert.deepEqual(restartA.spawn, restartBare.spawn);
  assert.equal(composeVerb(restartA), "restart");

  const startPending = expectOk(
    planComposeCommand(trustedConfig(), {
      operation: "start",
      instance_id: INSTANCE_A,
      desired: "running",
      observed: "pending",
      observed_revision: 3,
      revision: 4,
      operation_id: "start-pending",
    }),
  );
  const startBare = expectOk(planComposeCommand(trustedConfig(), { operation: "start", instance_id: INSTANCE_A }));
  assert.deepEqual(startPending.spawn, startBare.spawn);
  assert.equal(composeVerb(startPending), "up");

  const stopPending = expectOk(
    planComposeCommand(trustedConfig(), {
      operation: "stop",
      instance_id: INSTANCE_A,
      desired: "stopped",
      observed: "pending",
      observed_revision: 1,
      revision: 2,
      operation_id: "stop-pending",
    }),
  );
  const stopBare = expectOk(planComposeCommand(trustedConfig(), { operation: "stop", instance_id: INSTANCE_A }));
  assert.deepEqual(stopPending.spawn, stopBare.spawn);
  assert.equal(composeVerb(stopPending), "stop");

  for (const plan of [restartA, startPending, stopPending]) {
    const keys = Object.keys(plan);
    for (const leaked of ["revision", "operation_id", "desired", "observed", "observed_revision", "expected_revision"]) {
      assert.equal(keys.includes(leaked), false, `plan must not emit ${leaked}`);
    }
    assert.equal(JSON.stringify(plan.spawn).includes("operation_id"), false);
  }
});

test("start and stop verbs stay distinct from restart", () => {
  const start = expectOk(planComposeCommand(trustedConfig(), { operation: "start", instance_id: INSTANCE_A }));
  const stop = expectOk(planComposeCommand(trustedConfig(), { operation: "stop", instance_id: INSTANCE_A }));
  assert.equal(composeVerb(start), "up");
  assert.equal(start.spawn.args.includes("restart"), false);
  assert.equal(composeVerb(stop), "stop");
  assert.equal(stop.spawn.args.includes("restart"), false);
  assert.equal(stop.spawn.args.includes("up"), false);
});
