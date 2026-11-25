import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";

// Config: env vars, or a botsocial.env file in the working directory (see botsocial.env.example).
// This module is imported first by main.ts so process.env is complete before platform/policy are evaluated.
const envFile = process.env.BOTSOCIAL_ENV_FILE ?? "botsocial.env";
if (existsSync(envFile)) loadEnvFile(envFile);
