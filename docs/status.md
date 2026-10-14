# Status

One row per release. Benchmarks run `npm run test:load` on the same 4 vCPU host, main then branch, nothing else running.

| Version | Date | Storefront req/s (p50 / p95 ms) | Serviceability API req/s (p50 / p95 ms) | Failed requests | Tests | Audit (production) | Security scan |
| --- | --- | --- | --- | --- | --- | --- | --- |
| BUH-01.00.00 | 2026-10-14 | 826 / 805 (77–70 / 125–108); main 785 / 848 | 574 / 577 (82–77 / 131–139); main 598 / 601 | 0 | 26 passed | 0 vulnerabilities | No new scan (not available here) |

**Notes for BUH-01.00.00**
- The serviceability API is about 4% slower than main: the cost of input validation and the per-address limit.
- The full `npm audit` lists 5 high findings in ESLint's dev-only dependency chain, the same as on main; nothing ships to production.
- **Measured and rejected: a per-request nonce CSP.** It took the storefront from ~790 to ~145 req/s, because every page renders per request. Even an idle proxy cost ~35%. See [security](security.md).
