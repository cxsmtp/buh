/**
 * Tests only: BUH_TEST_<SERVICE>_API=http://127.0.0.1:<port>/ sends a service's calls (Stripe,
 * Anthropic, Gemini, Google Drive) to a stand-in on the same machine. Anything but a plain-http
 * loopback address is ignored, and a production build (NODE_ENV=production, as in the image)
 * ignores it too unless the test server's own flag BUH_TEST_SERVER=1 is set (test/server.mts), so
 * a value left over in a shop's environment can never point it anywhere.
 */
export function testStandIn(name: string): URL | null {
  const v = process.env[name];
  if (!v) return null;
  if (process.env.NODE_ENV === 'production' && process.env.BUH_TEST_SERVER !== '1') return null;
  try {
    const u = new URL(v);
    if (u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost') && u.port && u.pathname === '/' && !u.search) return u;
  } catch {
    // not an address
  }
  return null;
}
