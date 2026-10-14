#!/usr/bin/env node
// Make an ADMIN_PASSWORD_HASH for the environment:
//   npm run hash-password            (prompts, input hidden)
//   echo -n 'passphrase' | npm run hash-password --silent
// Same format and cost as src/lib/server/password.ts: scrypt$N$r$p$salt$hash.
import crypto from 'node:crypto';
import readline from 'node:readline';

async function readPassword() {
  if (!process.stdin.isTTY) {
    let data = '';
    for await (const chunk of process.stdin) data += chunk;
    return data.replace(/\r?\n$/, '');
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  rl._writeToOutput = (s) => { if (!s.includes('\n') && s !== 'New admin password: ') return; rl.output.write(s); };
  const answer = await new Promise((resolve) => rl.question('New admin password: ', resolve));
  rl.close();
  process.stdout.write('\n');
  return answer;
}

const password = await readPassword();
if (password.length < 12 || password.length > 256 || new Set(password).size < 5) {
  console.error('Use 12–256 characters with at least 5 different characters.');
  process.exit(1);
}
const salt = crypto.randomBytes(16);
const key = crypto.scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1 });
console.log(['scrypt', 16384, 8, 1, salt.toString('base64url'), key.toString('base64url')].join('$'));
