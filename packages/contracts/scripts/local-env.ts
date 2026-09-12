/**
 * Load packages/contracts/.env before the root .env: the deployment secrets
 * live next to the contracts, and a value set here wins over the root file.
 * Imported first by deploy.ts for its side effect; shell variables still win
 * over both files.
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".env");
if (existsSync(file)) {
  for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (value && process.env[key] === undefined) process.env[key] = value;
  }
}
