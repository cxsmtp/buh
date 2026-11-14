#!/usr/bin/env node
// Runs every test file (test/*.test.mts) for CI, a few at a time, each with its own temp folder.
// A file that fails is run once more on its own: a real failure fails twice, and the job with it.
// Usage: node scripts/ci-test.mjs [--jobs N] [files…]   (build first: the end-to-end tests start it)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const jobsAt = args.indexOf('--jobs');
const jobs = Math.max(1, Number(jobsAt >= 0 ? args.splice(jobsAt, 2)[1] : process.env.TEST_JOBS) || Math.max(1, Math.min(4, os.cpus().length - 1)));
const files = (args.length ? args : fs.readdirSync('test').filter((f) => f.endsWith('.test.mts')).map((f) => path.join('test', f))).sort();
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'buh-ci-'));

function run(file) {
  return new Promise((resolve) => {
    const tmp = fs.mkdtempSync(path.join(root, 't-'));
    const started = Date.now();
    let out = '';
    const child = spawn(process.execPath, ['--import', 'tsx', '--test', '--test-reporter=tap', file], { env: { ...process.env, TMPDIR: tmp }, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => child.kill('SIGKILL'), 15 * 60_000);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('close', (code) => {
      clearTimeout(timer);
      fs.rmSync(tmp, { recursive: true, force: true });
      const count = (k) => Number(new RegExp(`^# ${k} (\\d+)`, 'm').exec(out)?.[1] ?? 0);
      resolve({ file, ok: code === 0, pass: count('pass'), fail: count('fail'), seconds: Math.round((Date.now() - started) / 1000), out });
    });
  });
}

async function pool(list, n) {
  const results = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, list.length) }, async () => {
      while (next < list.length) {
        const r = await run(list[next++]);
        console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.file} (${r.pass} passed${r.fail ? `, ${r.fail} failed` : ''}, ${r.seconds}s)`);
        results.push(r);
      }
    })
  );
  return results;
}

const first = await pool(files, jobs);
const failed = first.filter((r) => !r.ok);
let still = [];
if (failed.length) {
  console.log(`\nRunning ${failed.length} failed file(s) once more, one at a time…`);
  still = (await pool(failed.map((r) => r.file), 1)).filter((r) => !r.ok);
}
fs.rmSync(root, { recursive: true, force: true });
const passed = first.reduce((n, r) => n + r.pass, 0);
console.log(`\n${files.length} files, ${passed} tests passed on the first run; ${failed.length} file(s) failed first, ${still.length} failed twice.`);
for (const r of failed.filter((f) => !still.some((s) => s.file === f.file))) console.log(`passed on the second run (look at it: a test that sometimes fails): ${r.file}`);
for (const r of still) {
  console.log(`\n──── ${r.file} ────`);
  // Each failed test with its whole report (the message, what was expected, where), not only the headings.
  const lines = r.out.split('\n');
  const shown = [];
  for (let i = 0; i < lines.length && shown.length < 200; i++) {
    if (!/^\s*not ok/.test(lines[i])) continue;
    shown.push(lines[i]);
    for (let j = i + 1; j < lines.length && j < i + 45 && !/^\s*(not ok|ok) /.test(lines[j]); j++) shown.push(lines[j]);
  }
  console.log(shown.join('\n'));
}
process.exit(still.length ? 1 : 0);
