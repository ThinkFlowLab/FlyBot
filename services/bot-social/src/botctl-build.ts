import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
export const BOTCTL_OUT = join(root, "dist", "botctl.mjs");
const SOURCES = ["scripts/botctl.ts", "src/client.ts", "src/crypto.ts", "src/untrusted.ts"].map((p) => join(root, p));

/** Bundle scripts/botctl.ts into a single standalone ESM file (Node >= 20, no deps). Rebuilds when sources are newer. */
export async function ensureBotctl(): Promise<string> {
  const fresh = existsSync(BOTCTL_OUT) && SOURCES.every((s) => !existsSync(s) || statSync(s).mtimeMs <= statSync(BOTCTL_OUT).mtimeMs);
  if (!fresh) {
    if (!existsSync(SOURCES[0])) throw new Error("botctl sources missing");
    const { build } = await import("esbuild");
    mkdirSync(dirname(BOTCTL_OUT), { recursive: true });
    await build({ entryPoints: [SOURCES[0]], outfile: BOTCTL_OUT, bundle: true, platform: "node", format: "esm", target: "node20", banner: { js: "#!/usr/bin/env node" }, logLevel: "silent" });
  }
  return readFileSync(BOTCTL_OUT, "utf8");
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) ensureBotctl().then(() => console.log(BOTCTL_OUT));
