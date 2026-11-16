import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";

/**
 * The permission bits of an existing regular file at `path`, or `undefined`
 * when there is none (a symlink at `path` is replaced, never followed).
 */
function existingMode(path: string): number | undefined {
  try {
    const st = lstatSync(path);
    return st.isFile() ? st.mode & 0o777 : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Write `content` to `path` atomically: into a temp file beside it, then a
 * rename, so a reader never sees half a file. Parent directories are created.
 *
 * CFG-2: the temp name is random and the temp file is created exclusively
 * (`O_EXCL`, plus `O_NOFOLLOW` where the platform has it), so a symlink or
 * file planted at a guessable temp path is never written through or removed.
 * CFG-7: an existing file keeps its permission bits (a 0600 file stays 0600),
 * and the data is fsynced before the rename.
 */
export function writeAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const mode = existingMode(path);
  const temp = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  const flags =
    constants.O_WRONLY |
    constants.O_CREAT |
    constants.O_EXCL |
    (constants.O_NOFOLLOW ?? 0);
  // Opening the temp file exclusively makes it ours; only then may a failure
  // remove it.
  const fd = openSync(temp, flags, mode ?? 0o666);
  let renamed = false;
  try {
    try {
      if (mode !== undefined) fchmodSync(fd, mode);
      const bytes = Buffer.from(content, "utf8");
      let offset = 0;
      while (offset < bytes.length) {
        offset += writeSync(fd, bytes, offset, bytes.length - offset);
      }
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, path);
    renamed = true;
  } finally {
    if (!renamed) rmSync(temp, { force: true });
  }
}
