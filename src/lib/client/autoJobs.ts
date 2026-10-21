/**
 * Which quick-add jobs to show (src/components/admin/inventory/QuickAdd.tsx). A product the AI
 * finished is in the shop: it leaves "Being made by AI" at once on the Inventory page, and stays
 * in the quick-add form's list only for a few minutes, as a "done" tick. Ones still being made, and
 * ones that need the owner, always show.
 */

export interface JobLike {
  state: string;
  updatedAt?: string;
}

/** How long a finished one stays in the quick-add form's list. */
export const DONE_SHOWN_MS = 5 * 60 * 1000;

export function visibleJobs<T extends JobLike>(jobs: T[], where: 'inventory' | 'form', now = Date.now()): T[] {
  return jobs.filter((j) => {
    if (j.state !== 'done') return true;
    if (where === 'inventory') return false;
    const at = Date.parse(j.updatedAt ?? '');
    return Number.isFinite(at) && now - at < DONE_SHOWN_MS;
  });
}
