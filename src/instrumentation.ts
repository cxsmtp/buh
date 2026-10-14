/** Called once when the Next.js server starts. */
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { onStartup } = await import('./lib/server/startup');
    await onStartup();
  }
}
