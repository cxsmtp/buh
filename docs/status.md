# Status

One row per release. Benchmarks run `npm run test:load` on the same 4 vCPU host, main then branch, nothing else running.

| Version | Date | Storefront req/s (p50 / p95 ms) | Serviceability API req/s (p50 / p95 ms) | Failed requests | Tests | Audit (production) | Security scan |
| --- | --- | --- | --- | --- | --- | --- | --- |
| BUH-01.00.00 | 2026-10-14 | branch 707 / 748 / 757 / 751; main 777 / 746 / 759 / 643 (p50 81–87 ms both; p95 136–170 vs 119–152 ms) | branch 598 / 467 / 501 / 497; main 548 / 547 / 622 / 513 (p50 78–100 vs 74–86 ms) | 0 | 76 passed | 0 vulnerabilities | No new scan (not available here) |

**Notes for BUH-01.00.00**
- Four rounds per build on a shared 4 vCPU host. The storefront medians match (≈ 750 req/s). The serviceability API median is ≈ 9% lower (≈ 500 vs ≈ 547 req/s), smaller than the spread between main's own rounds (513–622). The branch adds input validation there.
- The p95 tail on the storefront ran 136–170 ms on the branch against 119–152 ms on main, also within the spread.
- The full `npm audit` lists 5 high findings in ESLint's dev-only dependency chain, the same as on main; nothing ships to production.
- **Measured and rejected: a per-request nonce CSP.** It took the storefront from ~790 to ~145 req/s, because every page renders per request. Even an idle proxy cost ~35%. See [security](security.md).
