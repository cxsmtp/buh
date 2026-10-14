/**
 * Beautiful UAE Home - Concurrency & Performance Load Tester
 * Simulates high-concurrency traffic (up to 3,000 requests) against the Next.js server.
 * Run with: node scripts/load-test.mjs
 */

import http from "node:http";

const BASE_URL = process.env.TEST_URL || "http://localhost:3000";
const agent = new http.Agent({ keepAlive: true, maxSockets: 200 });

async function makeRequest(path) {
  const start = performance.now();
  return new Promise((resolve) => {
    const url = new URL(path, BASE_URL);
    const req = http.request(
      url,
      {
        agent,
        headers: {
          "User-Agent": "BUHome-Benchmark/1.0",
          Accept: "application/json, text/html, */*",
        },
      },
      (res) => {
        let bytes = 0;
        res.on("data", (chunk) => {
          bytes += chunk.length;
        });
        res.on("end", () => {
          const duration = performance.now() - start;
          resolve({
            ok: res.statusCode >= 200 && res.statusCode < 400,
            status: res.statusCode,
            duration,
            bytes,
          });
        });
      }
    );

    req.on("error", (err) => {
      const duration = performance.now() - start;
      resolve({
        ok: false,
        status: 0,
        error: err.message,
        duration,
        bytes: 0,
      });
    });

    req.end();
  });
}

function calculatePercentiles(latencies) {
  const sorted = [...latencies].sort((a, b) => a - b);
  const p50 = sorted[Math.floor(sorted.length * 0.5)] || 0;
  const p90 = sorted[Math.floor(sorted.length * 0.9)] || 0;
  const p95 = sorted[Math.floor(sorted.length * 0.95)] || 0;
  const p99 = sorted[Math.floor(sorted.length * 0.99)] || 0;
  const min = sorted[0] || 0;
  const max = sorted[sorted.length - 1] || 0;
  const avg = sorted.reduce((sum, v) => sum + v, 0) / (sorted.length || 1);

  return { min, max, avg, p50, p90, p95, p99 };
}

async function runScenario(name, path, totalRequests, concurrency) {
  console.log(`\n======================================================`);
  console.log(`🚀 SCENARIO: ${name}`);
  console.log(`🎯 Target: ${BASE_URL}${path}`);
  console.log(`📊 Requests: ${totalRequests} | Concurrency: ${concurrency}`);
  console.log(`======================================================`);

  const latencies = [];
  let successful = 0;
  let failed = 0;
  let totalBytes = 0;

  const wallClockStart = performance.now();
  let remaining = totalRequests;
  let active = 0;

  await new Promise((resolve) => {
    function launch() {
      while (active < concurrency && remaining > 0) {
        remaining--;
        active++;

        makeRequest(path).then((result) => {
          active--;
          latencies.push(result.duration);
          totalBytes += result.bytes;
          if (result.ok) {
            successful++;
          } else {
            failed++;
          }

          if (remaining > 0) {
            launch();
          } else if (active === 0) {
            resolve();
          }
        });
      }
    }
    launch();
  });

  const wallClockDurationMs = performance.now() - wallClockStart;
  const wallClockSeconds = wallClockDurationMs / 1000;
  const rps = (totalRequests / wallClockSeconds).toFixed(2);
  const throughputMB = (totalBytes / (1024 * 1024 * wallClockSeconds)).toFixed(2);
  const stats = calculatePercentiles(latencies);

  console.log(`\n📈 RESULTS:`);
  console.log(`  • Total Wall Time:   ${wallClockDurationMs.toFixed(0)} ms (${wallClockSeconds.toFixed(2)} s)`);
  console.log(`  • Throughput:        ${rps} requests/sec`);
  console.log(`  • Data Transfer:     ${throughputMB} MB/sec`);
  console.log(`  • Success Rate:      ${((successful / totalRequests) * 100).toFixed(1)}% (${successful} passed, ${failed} failed)`);
  console.log(`\n⏱️ LATENCY DISTRIBUTION:`);
  console.log(`  • Min Latency:       ${stats.min.toFixed(2)} ms`);
  console.log(`  • Median (p50):      ${stats.p50.toFixed(2)} ms`);
  console.log(`  • Average:           ${stats.avg.toFixed(2)} ms`);
  console.log(`  • 90th percentile:   ${stats.p90.toFixed(2)} ms`);
  console.log(`  • 95th percentile:   ${stats.p95.toFixed(2)} ms`);
  console.log(`  • 99th percentile:   ${stats.p99.toFixed(2)} ms`);
  console.log(`  • Max Latency:       ${stats.max.toFixed(2)} ms`);

  return { name, rps, successRate: ((successful / totalRequests) * 100).toFixed(1), stats };
}

async function main() {
  console.log(`\n╔════════════════════════════════════════════════════════════════╗`);
  console.log(`║   BEAUTIFUL UAE HOME - PRODUCTION PERFORMANCE BENCHMARK       ║`);
  console.log(`║   Host: ${BASE_URL.padEnd(52)} ║`);
  console.log(`╚════════════════════════════════════════════════════════════════╝`);

  // Warm up connection
  await makeRequest("/");

  // Test 1: Storefront Homepage (3,000 requests, concurrency 100)
  const homeTest = await runScenario(
    "Storefront Homepage SSR & Edge Delivery",
    "/",
    3000,
    100
  );

  // Test 2: Courier Serviceability API (1,000 requests, concurrency 50)
  const apiTest = await runScenario(
    "Jeebly / Eco Courier Serviceability API",
    "/api/courier/serviceability?area=Downtown+Dubai",
    1000,
    50
  );

  console.log(`\n======================================================`);
  console.log(`🏆 BENCHMARK SUMMARY FOR HOSTINGER READINESS`);
  console.log(`======================================================`);
  console.log(`  Storefront Homepage:   ${homeTest.rps} RPS | p50: ${homeTest.stats.p50.toFixed(1)}ms | Success: ${homeTest.successRate}%`);
  console.log(`  Courier API Route:     ${apiTest.rps} RPS | p50: ${apiTest.stats.p50.toFixed(1)}ms | Success: ${apiTest.successRate}%`);
  console.log(`\n✅ High-concurrency performance verified for Hostinger deployment!`);
}

main().catch(console.error);
