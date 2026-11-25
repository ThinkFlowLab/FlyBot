// This marker identifies a page served from the user's own DS-Bot runtime.
export function dsbotServed(document) {
  return Boolean(document.querySelector?.('meta[name="flybot-workspace-instance"]'));
}
