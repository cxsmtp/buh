/** Called once when the Next.js server starts. */
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    // First, so the very first requests already pass through it: the Admin Hub's door and the
    // scanner slow-down (src/lib/server/frontGate.ts).
    const { installFrontGate } = await import('./lib/server/frontGate');
    installFrontGate();
    const { onStartup } = await import('./lib/server/startup');
    await onStartup();
  }
}
