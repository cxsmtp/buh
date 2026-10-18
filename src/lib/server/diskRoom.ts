import fs from 'node:fs';
import path from 'node:path';

/**
 * Room for an upload, so customers' screenshots or the owner's bills can't fill the disk (or make
 * backups too big to make): nothing is taken while the disk has less than `minFreeBytes` free
 * after it, or once the folder would hold more than `folderBytes`. Used by the bank-transfer
 * receipts (src/lib/server/orders.ts) and the expense bills (src/lib/server/expenses.ts).
 */
export function folderRoomProblem(dir: string, incoming: number, limits: { folderBytes: number; minFreeBytes: number }, label: string): string | null {
  try {
    const st = fs.statfsSync(dir);
    const free = Number(st.bavail) * Number(st.bsize);
    if (free - incoming < limits.minFreeBytes) return `the disk has only ${Math.round(free / 1024 ** 2)} MB free`;
  } catch {
    // statfs unavailable: the folder cap below still applies
  }
  let used = 0;
  for (const f of fs.readdirSync(dir)) {
    try {
      used += fs.statSync(path.join(dir, f)).size;
    } catch {
      // removed meanwhile
    }
  }
  if (used + incoming > limits.folderBytes) return `the ${label} folder holds ${Math.round(used / 1024 ** 2)} MB (the cap is ${Math.round(limits.folderBytes / 1024 ** 2)} MB)`;
  return null;
}
