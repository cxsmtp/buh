// One "copy of the shop" trying to use a recovery code at an agreed moment
// (two of these race in test/admin-passkeys-recovery.test.mts).
//   node --import tsx test/fixtures/consume-recovery-code.mts <code> <start-at-ms>
const [code, startAt] = process.argv.slice(2);
const dbModule = await import('@/lib/server/db');
const codesModule = await import('@/lib/server/recoveryCodes');
const getDb = (dbModule as { getDb?: typeof import('@/lib/server/db').getDb }).getDb ?? (dbModule as unknown as { default: typeof import('@/lib/server/db') }).default.getDb;
const consume =
  (codesModule as { consumeRecoveryCode?: typeof import('@/lib/server/recoveryCodes').consumeRecoveryCode }).consumeRecoveryCode ??
  (codesModule as unknown as { default: typeof import('@/lib/server/recoveryCodes') }).default.consumeRecoveryCode;
getDb(); // open the database before the start line, so both copies are ready
while (Date.now() < Number(startAt)) {
  // spin until the agreed moment
}
process.stdout.write(String(consume(code)));
