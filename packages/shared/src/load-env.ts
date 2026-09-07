import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config as dotenv } from "dotenv";

/**
 * One `.env` at the repository root feeds every process. Entry points import
 * this module before anything else (`import "@o1bot/shared/load-env"`), so
 * the file is found no matter which package directory pnpm started the
 * process from. Values already present in the environment win, which is
 * what deployments (Railway, Vercel, Docker) rely on: they set variables per
 * service and ship no file at all.
 */

const ROOT_MARKER = "pnpm-workspace.yaml";

/** Walk up from `from` until the directory that holds pnpm-workspace.yaml. */
export function findRepoRoot(from: string = process.cwd()): string | null {
  let dir = resolve(from);
  for (;;) {
    if (existsSync(join(dir, ROOT_MARKER))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

let loaded: string | null | undefined;

/** Load `<repo root>/.env` once. Returns the path that was loaded, or null when there is none. */
export function loadRootEnv(): string | null {
  if (loaded !== undefined) return loaded;
  const root = findRepoRoot() ?? findRepoRoot(dirname(fileURLToPath(import.meta.url)));
  const file = root ? join(root, ".env") : null;
  if (file && existsSync(file)) {
    dotenv({ path: file, override: false, quiet: true });
    loaded = file;
  } else {
    loaded = null;
  }
  return loaded;
}

loadRootEnv();
