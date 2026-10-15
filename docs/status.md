# Status

One row per release. Benchmarks run `npm run test:load` on the same 4 vCPU host, main then branch, nothing else running.

| Version | Date | Storefront req/s (p50 / p95 ms) | Serviceability API req/s (p50 / p95 ms) | Failed requests | Tests | Audit (production) | Security scan |
| --- | --- | --- | --- | --- | --- | --- | --- |
| BUH-01.03.00 | 2026-10-15 | branch 508 / 602 / 613; main 517 / 694 / 567 (p50 96–176 vs 89–164 ms; p95 179–308 vs 130–301 ms) | branch 444 / 642 / 454; main 438 / 558 / 443 | 0 | 134 passed | 0 vulnerabilities | No scanner here; real Firebase SMS not testable here |
| BUH-01.02.00 | 2026-10-15 | branch 839 / 891 / 793; main 750 / 868 / 844 (p50 66–76 vs 66–77 ms; p95 104–111 vs 108–140 ms) | branch 657 / 621 / 722; main 606 / 734 / 663 | 0 | 120 passed | 0 vulnerabilities | No scanner here; image smoke-tested in CI (read-only, non-root, no capabilities) |
| BUH-01.01.00 | 2026-10-14 | branch 753 / 662 / 729; main 769 / 729 / 605 (p50 82–88 vs 79–86 ms; p95 139–148 vs 128–210 ms) | branch 568 / 598 / 525; main 591 / 495 / 490 | 0 on the branch (main has no `/api/products`, so its catalogue runs fail by design) | 118 passed | 0 vulnerabilities | Two reviews (security, correctness); no automated scanner here |
| BUH-01.00.00 | 2026-10-14 | branch 707 / 748 / 757 / 751; main 777 / 746 / 759 / 643 (p50 81–87 ms both; p95 136–170 vs 119–152 ms) | branch 598 / 467 / 501 / 497; main 548 / 547 / 622 / 513 (p50 78–100 vs 74–86 ms) | 0 | 76 passed | 0 vulnerabilities | No new scan (not available here) |

**Notes for BUH-01.03.00**
- The host was busy with other work (load average 3–5 before the runs), so all numbers are lower and noisier than last release, for main and branch alike. Three rounds each, alternating; the branch is level with main within the spread. The load test does not reach the new code; the only change on its paths is a longer CSP header.
- Firebase's SDK is a separate 130 KB chunk, loaded only at checkout when Firebase is on (checked in the build: not in the storefront's initial chunks).
- Checked in a real browser at 375 px and 1280 px: SMS tab with Firebase and checkout with Firebase on, no sideways scroll, no CSP errors. The browser had no route to Google, so the "could not send" message was shown; a real SMS was not sent.

**Notes for BUH-01.02.00**
- Three rounds per build, alternating. All three scenarios are level with main within the run-to-run spread; main's first catalogue round had a 391 ms p95 that did not repeat.
- The container image is built and started in GitHub Actions; this environment has no Docker daemon.

**Notes for BUH-01.01.00**
- Three rounds per build, alternating main and branch, on a shared 4 vCPU host. Storefront and serviceability medians are level with main, within the run-to-run spread.
- The new catalogue API (`/api/products`) serves 607–745 req/s with p50 128–162 ms and p95 up to 207 ms at 100 concurrent clients; the list is cached in memory, and the latency matches its throughput.
- Not run here: Docker itself (no Docker daemon in this environment). The compose file and Caddy setup were reviewed by reading.

**Notes for BUH-01.00.00**
- Four rounds per build on a shared 4 vCPU host. The storefront medians match (≈ 750 req/s). The serviceability API median is ≈ 9% lower (≈ 500 vs ≈ 547 req/s), smaller than the spread between main's own rounds (513–622). The branch adds input validation there.
- The p95 tail on the storefront ran 136–170 ms on the branch against 119–152 ms on main, also within the spread.
- The full `npm audit` lists 5 high findings in ESLint's dev-only dependency chain, the same as on main; nothing ships to production.
- **Measured and rejected: a per-request nonce CSP.** It took the storefront from ~790 to ~145 req/s, because every page renders per request. Even an idle proxy cost ~35%. See [security](security.md).
