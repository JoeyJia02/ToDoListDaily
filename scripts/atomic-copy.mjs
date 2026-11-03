import { constants, copyFileSync, renameSync, unlinkSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { randomUUID } from 'node:crypto';

// Replacing a running executable by truncating its inode can invalidate macOS's
// code-signing cache and crash either process. Prepare a fresh inode beside the
// destination and atomically rename it only after the copy succeeds.
export function atomicCopyFileSync(source, destination) {
  const temporary = join(dirname(destination), `.${basename(destination)}.${randomUUID()}.tmp`);
  try {
    copyFileSync(source, temporary, constants.COPYFILE_EXCL);
    renameSync(temporary, destination);
  } catch (error) {
    try { unlinkSync(temporary); } catch {}
    throw error;
  }
}
