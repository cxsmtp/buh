import fs from 'node:fs';
import path from 'node:path';

/**
 * Room on the disk, so customers' screenshots, the owner's bills, an export or a backup can't fill
 * it (or make backups too big to make): nothing is written while the disk would have less than
 * `minFreeBytes` free after it. Used by the bank-transfer receipts (src/lib/server/orders.ts), the
 * expense bills (src/lib/server/expenses.ts) and the accountant's export (src/lib/server/reports.ts).
 */
export function diskRoomProblem(dir: string, incoming: number, minFreeBytes: number): string | null {
  try {
    const st = fs.statfsSync(dir);
    const free = Number(st.bavail) * Number(st.bsize);
    if (free - incoming < minFreeBytes) return `the disk has only ${Math.round(free / 1024 ** 2)} MB free`;
  } catch {
    // statfs unavailable: nothing to go by
  }
  return null;
}

/** The bytes in a folder's files (not its subfolders). */
export function folderBytes(dir: string): number {
  let used = 0;
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return 0;
  }
  for (const f of names) {
    try {
      const st = fs.statSync(path.join(dir, f));
      if (st.isFile()) used += st.size;
    } catch {
      // removed meanwhile
    }
  }
  return used;
}

/** As diskRoomProblem, and the folder may hold at most `folderBytes` with the new file. */
export function folderRoomProblem(dir: string, incoming: number, limits: { folderBytes: number; minFreeBytes: number }, label: string): string | null {
  const disk = diskRoomProblem(dir, incoming, limits.minFreeBytes);
  if (disk) return disk;
  const used = folderBytes(dir);
  if (used + incoming > limits.folderBytes) return `the ${label} folder holds ${Math.round(used / 1024 ** 2)} MB (the cap is ${Math.round(limits.folderBytes / 1024 ** 2)} MB)`;
  return null;
}
