export class ApiError extends Error {
  constructor(public status: number, public code: string, message?: string, public extra: Record<string, unknown> = {}) {
    super(message ?? code);
  }
}
export function assert(cond: unknown, status: number, code: string, message?: string, extra?: Record<string, unknown>): asserts cond {
  if (!cond) throw new ApiError(status, code, message, extra);
}
