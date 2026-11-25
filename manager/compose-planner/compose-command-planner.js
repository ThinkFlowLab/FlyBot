/**
 * Allowlisted Docker Compose command planner (local draft).
 *
 * This module only plans spawn-style { executable, args, shell:false } commands.
 * It does not run Docker, touch the filesystem, or implement HTTP/storage/server
 * state. Untrusted requests may supply operation, instance_id, and logs.tail.
 * Image, command, mounts, paths, env, compose file, project name, and executable
 * come only from a trusted preregistered registry.
 *
 * Original work for FlyBot. Do not treat this as a copy of any
 * unlicensed control-plane source.
 *
 * This planner is stateless. Locked contract idempotency is caller-side:
 * start/stop reuse revision/operation_id when desired is already the target
 * (including pending, observed_revision < revision); restart is a distinct
 * operation whose same operation_id is reused and whose new operation_id
 * triggers a real process recycle. This module does not read or emit
 * revision, operation_id, desired, or observed, and must not pretend to
 * implement those rules. When the caller does invoke it for restart, the
 * plan is exactly one `compose restart` command — never `up`, and never a
 * stop+start pair.
 */

export const ERROR_CODES = Object.freeze({
  INVALID_REQUEST: "invalid_request",
  INVALID_CONFIG: "invalid_config",
  INVALID_INSTANCE_ID: "invalid_instance_id",
  UNKNOWN_INSTANCE: "unknown_instance",
  UNKNOWN_OPERATION: "unknown_operation",
  UNSUPPORTED: "unsupported",
  UNTRUSTED_PARAMETER: "untrusted_parameter",
  INVALID_LOGS_OPTION: "invalid_logs_option",
});

/** Operations this planner will emit a compose command for. */
export const PLANNED_OPERATIONS = Object.freeze([
  "create",
  "start",
  "stop",
  "restart",
  "inspect",
  "logs",
]);

/** Contract operations that must fail with a stable `unsupported` error. */
export const UNSUPPORTED_OPERATIONS = Object.freeze([
  "backup",
  "restore",
  "upgrade",
  "reclaim",
  "purge",
]);

const INSTANCE_ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
const PROJECT_PREFIX_RE = /^[a-z][a-z0-9]{0,15}$/;
const SERVICE_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,62}$/;
const VOLUME_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,62}$/;
const IMAGE_REF_RE = /^[a-z0-9._/-]+:[A-Za-z0-9._-]+$/;
const FORBIDDEN_IDS = new Set(["__proto__", "constructor", "prototype", "proto"]);
const DEFAULT_EXECUTABLE = "docker";
const DEFAULT_PREFIX = "ot";
const DEFAULT_TAIL = 100;
const MIN_TAIL = 1;
const MAX_TAIL = 10_000;

/**
 * Request keys that must never influence a plan. Presence fails closed.
 * These are read only to reject them; values are discarded.
 */
const UNTRUSTED_OVERRIDE_KEYS = Object.freeze([
  "image",
  "image_ref",
  "imageRef",
  "command",
  "cmd",
  "entrypoint",
  "mount",
  "mounts",
  "bind",
  "binds",
  "volume",
  "volumes",
  "path",
  "paths",
  "cwd",
  "env",
  "environment",
  "composeFile",
  "compose_file",
  "composeFilePath",
  "file",
  "projectName",
  "project_name",
  "project",
  "executable",
  "shell",
  "args",
  "argv",
  "docker",
  "dockerfile",
  "Dockerfile",
  "network",
  "privileged",
  "user",
  "workdir",
  "spawn",
]);

function fail(code, message) {
  return {
    ok: false,
    error: { code, message },
  };
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isObjectRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function own(object, key) {
  return isPlainObject(object) && Object.prototype.hasOwnProperty.call(object, key);
}

function ownString(object, key) {
  if (!own(object, key)) return undefined;
  const value = object[key];
  return typeof value === "string" ? value : undefined;
}

function hasDisallowedSegments(absolutePath) {
  if (typeof absolutePath !== "string" || absolutePath.length === 0) return true;
  if (absolutePath.includes("\0") || /[\r\n]/.test(absolutePath)) return true;
  // Planner does not resolve symlinks or touch the filesystem. It only rejects
  // string forms that cannot be a safe absolute POSIX path.
  if (!absolutePath.startsWith("/")) return true;
  if (absolutePath.startsWith("//")) return true;
  const segments = absolutePath.split("/");
  for (const segment of segments) {
    if (segment === "." || segment === "..") return true;
  }
  return false;
}

function validateExecutable(executable) {
  if (executable === DEFAULT_EXECUTABLE) return true;
  if (typeof executable !== "string") return false;
  if (hasDisallowedSegments(executable)) return false;
  return executable.endsWith("/docker");
}

function validateInstanceId(instanceId) {
  if (typeof instanceId !== "string") return false;
  if (FORBIDDEN_IDS.has(instanceId)) return false;
  if (instanceId.includes(".") || instanceId.includes("/") || instanceId.includes("\\")) {
    return false;
  }
  return INSTANCE_ID_RE.test(instanceId);
}

function deriveProjectName(prefix, instanceId) {
  return `${prefix}-${instanceId}`;
}

function validateArg(value) {
  return typeof value === "string" && value.length > 0 && !value.includes("\0") && !/[\r\n]/.test(value);
}

function forbiddenArgv(args) {
  for (const arg of args) {
    if (!validateArg(arg)) return "invalid_argument";
    const lower = arg.toLowerCase();
    if (lower === "down" || lower === "rm" || lower === "run" || lower === "exec") {
      return arg;
    }
    if (arg === "-v" || arg === "--volumes" || arg === "--rmi" || arg === "--build") {
      return arg;
    }
    if (arg === "-c" || arg === "--shell") return arg;
  }
  return null;
}

function normalizeRegistry(trustedConfig) {
  if (!isPlainObject(trustedConfig)) {
    return { error: fail(ERROR_CODES.INVALID_CONFIG, "Trusted registry must be a plain object.") };
  }

  const executable = own(trustedConfig, "executable")
    ? trustedConfig.executable
    : DEFAULT_EXECUTABLE;
  if (!validateExecutable(executable)) {
    return {
      error: fail(
        ERROR_CODES.INVALID_CONFIG,
        "Trusted executable must be 'docker' or an absolute path ending in /docker.",
      ),
    };
  }

  const projectPrefix = own(trustedConfig, "projectPrefix")
    ? trustedConfig.projectPrefix
    : DEFAULT_PREFIX;
  if (typeof projectPrefix !== "string" || !PROJECT_PREFIX_RE.test(projectPrefix)) {
    return { error: fail(ERROR_CODES.INVALID_CONFIG, "Trusted projectPrefix is invalid.") };
  }

  if (!own(trustedConfig, "instances") || !isObjectRecord(trustedConfig.instances)) {
    return {
      error: fail(ERROR_CODES.INVALID_CONFIG, "Trusted registry.instances must be an object."),
    };
  }

  const cwd = own(trustedConfig, "cwd") ? trustedConfig.cwd : null;
  if (cwd !== null && (typeof cwd !== "string" || hasDisallowedSegments(cwd))) {
    return {
      error: fail(ERROR_CODES.INVALID_CONFIG, "Trusted cwd must be an absolute POSIX path without '..'."),
    };
  }

  const instances = new Map();
  for (const instanceId of Object.keys(trustedConfig.instances)) {
    if (!validateInstanceId(instanceId)) {
      return {
        error: fail(
          ERROR_CODES.INVALID_CONFIG,
          "Trusted registry contains an unsafe or invalid instance_id key.",
        ),
      };
    }
    const record = trustedConfig.instances[instanceId];
    if (!isPlainObject(record)) {
      return { error: fail(ERROR_CODES.INVALID_CONFIG, "Trusted instance record must be a plain object.") };
    }
    const composeFile = ownString(record, "composeFile");
    if (!composeFile || hasDisallowedSegments(composeFile)) {
      return {
        error: fail(
          ERROR_CODES.INVALID_CONFIG,
          "Trusted composeFile must be an absolute POSIX path without '.' or '..' segments.",
        ),
      };
    }
    const serviceName = ownString(record, "serviceName");
    if (!serviceName || !SERVICE_NAME_RE.test(serviceName)) {
      return { error: fail(ERROR_CODES.INVALID_CONFIG, "Trusted serviceName is invalid.") };
    }
    const volumeName = own(record, "volumeName") ? record.volumeName : undefined;
    if (volumeName !== undefined && (typeof volumeName !== "string" || !VOLUME_NAME_RE.test(volumeName))) {
      return { error: fail(ERROR_CODES.INVALID_CONFIG, "Trusted volumeName is invalid.") };
    }
    const imageRef = own(record, "imageRef") ? record.imageRef : undefined;
    if (imageRef !== undefined && (typeof imageRef !== "string" || !IMAGE_REF_RE.test(imageRef))) {
      return { error: fail(ERROR_CODES.INVALID_CONFIG, "Trusted imageRef is invalid.") };
    }
    // Ignore any unexpected record fields; they cannot change lookup keys.
    instances.set(instanceId, Object.freeze({
      composeFile,
      serviceName,
      volumeName: volumeName ?? null,
      imageRef: imageRef ?? null,
      projectName: deriveProjectName(projectPrefix, instanceId),
    }));
  }

  return {
    registry: Object.freeze({
      executable,
      projectPrefix,
      cwd,
      instances,
    }),
  };
}

function rejectUntrustedOverrides(request) {
  for (const key of UNTRUSTED_OVERRIDE_KEYS) {
    if (own(request, key)) {
      return fail(
        ERROR_CODES.UNTRUSTED_PARAMETER,
        "Request cannot choose image, command, mount, path, env, compose file, project name, or executable.",
      );
    }
  }
  return null;
}

function readTail(request) {
  let opts = undefined;
  if (own(request, "opts")) opts = request.opts;
  else if (own(request, "logs")) opts = request.logs;

  let tail = DEFAULT_TAIL;
  if (opts !== undefined) {
    if (!isPlainObject(opts)) {
      return { error: fail(ERROR_CODES.INVALID_LOGS_OPTION, "logs options must be a plain object.") };
    }
    for (const key of UNTRUSTED_OVERRIDE_KEYS) {
      if (own(opts, key)) {
        return {
          error: fail(
            ERROR_CODES.UNTRUSTED_PARAMETER,
            "Request cannot choose image, command, mount, path, env, compose file, project name, or executable.",
          ),
        };
      }
    }
    if (own(opts, "tail")) {
      const raw = opts.tail;
      if (typeof raw === "number" && Number.isInteger(raw)) tail = raw;
      else if (typeof raw === "string" && /^[0-9]+$/.test(raw)) tail = Number.parseInt(raw, 10);
      else {
        return { error: fail(ERROR_CODES.INVALID_LOGS_OPTION, "logs.tail must be an integer in range.") };
      }
    }
  } else if (own(request, "tail")) {
    const raw = request.tail;
    if (typeof raw === "number" && Number.isInteger(raw)) tail = raw;
    else if (typeof raw === "string" && /^[0-9]+$/.test(raw)) tail = Number.parseInt(raw, 10);
    else {
      return { error: fail(ERROR_CODES.INVALID_LOGS_OPTION, "logs.tail must be an integer in range.") };
    }
  }

  if (!Number.isInteger(tail) || tail < MIN_TAIL || tail > MAX_TAIL) {
    return { error: fail(ERROR_CODES.INVALID_LOGS_OPTION, "logs.tail must be an integer in range.") };
  }
  return { tail };
}

function composeArgs(projectName, composeFile, commandArgs) {
  return ["compose", "--project-name", projectName, "--file", composeFile, ...commandArgs];
}

/**
 * Plan a single allowlisted compose command.
 *
 * @param {object} trustedConfig Preregistered registry (not request-controlled).
 * @param {object} untrustedRequest { operation, instance_id, opts?: { tail } }
 * @returns {{ ok: true, plan: object } | { ok: false, error: { code: string, message: string } }}
 */
export function planComposeCommand(trustedConfig, untrustedRequest) {
  const normalized = normalizeRegistry(trustedConfig);
  if (normalized.error) return normalized.error;

  if (!isPlainObject(untrustedRequest)) {
    return fail(ERROR_CODES.INVALID_REQUEST, "Request must be a plain object.");
  }

  const overrideError = rejectUntrustedOverrides(untrustedRequest);
  if (overrideError) return overrideError;

  if (!own(untrustedRequest, "operation") || typeof untrustedRequest.operation !== "string") {
    return fail(ERROR_CODES.UNKNOWN_OPERATION, "Operation is missing or not a string.");
  }
  const operation = untrustedRequest.operation;
  if (UNSUPPORTED_OPERATIONS.includes(operation)) {
    return fail(
      ERROR_CODES.UNSUPPORTED,
      `Operation '${operation}' is a documented contract gap and is not planned.`,
    );
  }
  if (!PLANNED_OPERATIONS.includes(operation)) {
    return fail(ERROR_CODES.UNKNOWN_OPERATION, "Operation is not an allowlisted compose action.");
  }

  const instanceId = ownString(untrustedRequest, "instance_id") ?? ownString(untrustedRequest, "instanceId");
  if (instanceId === undefined) {
    return fail(ERROR_CODES.INVALID_INSTANCE_ID, "instance_id is required.");
  }
  if (!validateInstanceId(instanceId)) {
    return fail(ERROR_CODES.INVALID_INSTANCE_ID, "instance_id is invalid.");
  }

  const record = normalized.registry.instances.get(instanceId);
  if (!record) {
    return fail(ERROR_CODES.UNKNOWN_INSTANCE, "instance_id is not in the trusted registry.");
  }

  let logsTail = null;
  if (operation === "logs") {
    const tailResult = readTail(untrustedRequest);
    if (tailResult.error) return tailResult.error;
    logsTail = tailResult.tail;
  }

  const { projectName, composeFile, serviceName, volumeName, imageRef } = record;
  let commandArgs;
  switch (operation) {
    case "create":
      // Create containers and named volumes from the preregistered compose file.
      // Does not start the service.
      commandArgs = ["create", "--no-build", serviceName];
      break;
    case "start":
      commandArgs = ["up", "-d", "--no-build", serviceName];
      break;
    case "stop":
      commandArgs = ["stop", serviceName];
      break;
    case "restart":
      // Single explicit compose restart. Not `up`, not stop then start.
      commandArgs = ["restart", serviceName];
      break;
    case "inspect":
      commandArgs = ["ps", "--all", serviceName];
      break;
    case "logs":
      commandArgs = ["logs", "--no-color", "--tail", String(logsTail), serviceName];
      break;
    default:
      return fail(ERROR_CODES.UNKNOWN_OPERATION, "Operation is not an allowlisted compose action.");
  }

  const args = composeArgs(projectName, composeFile, commandArgs);
  const bad = forbiddenArgv(args);
  if (bad) {
    return fail(ERROR_CODES.INVALID_CONFIG, "Planner refused to emit a disallowed argument.");
  }

  const plan = {
    operation,
    instance_id: instanceId,
    projectName,
    serviceName,
    composeFile,
    volumeName,
    // imageRef is echoed only from the trusted registry, never from the request.
    // It is not passed as a docker run/image override flag.
    imageRef,
    volumePolicy: "retain",
    spawn: {
      executable: normalized.registry.executable,
      args,
      shell: false,
      cwd: normalized.registry.cwd,
      env: null,
    },
  };

  return { ok: true, plan };
}

export const LIMITS = Object.freeze({
  DEFAULT_TAIL,
  MIN_TAIL,
  MAX_TAIL,
  DEFAULT_EXECUTABLE,
  DEFAULT_PREFIX,
});
