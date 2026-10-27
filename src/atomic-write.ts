import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Write `content` to `path` atomically: into a temp file beside it, then a
 * rename, so a reader never sees half a file. Parent directories are created.
 */
export function writeAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temp, content, "utf8");
    renameSync(temp, path);
  } finally {
    rmSync(temp, { force: true });
  }
}
