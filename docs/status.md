# Status

One row per release. Benchmarks run `npm run test:load` on the same 4 vCPU host, main then branch, nothing else running.

| Version | Date | Storefront req/s (p50 / p95 ms) | Serviceability API req/s (p50 / p95 ms) | Failed requests | Tests | Audit (production) | Security scan |
| --- | --- | --- | --- | --- | --- | --- | --- |
| BUH-02.10.00 | 2026-10-18 | branch 931 / 959 / 966; main 921 / 899 / 894 (p95 78–95 vs 85–98 ms) | branch 762 / 713 / 685; main 748 / 768 / 720 | 0 | 630/631 (1 load timeout, passes alone) | 0 vulnerabilities | Independent review: 1 high, 4 medium, 5 low, all fixed with tests |
| BUH-02.09.01 | 2026-10-18 | not run: two small screen fixes (hub chats, Track Order box), no server code changed | not run | — | 582 passed (4 browser tests timed out under load from other builds, then passed on their own; one Stripe browser test made to wait for the redraw) | 0 vulnerabilities | Not applicable (no new input, route or data) |
| BUH-02.09.00 | 2026-10-18 | branch 942 / 885 / 866 / 881 / 896; main 911 / 954 / 820 / 821 / 915 (p95 82–152 vs 102–136 ms) | branch 769 / 739 / 701 / 647 / 734; main 642 / 733 / 681 / 700 / 747 | 0 | 580 passed | 0 vulnerabilities | Two independent reviews (payments + WhatsApp; bank transfer), all findings fixed with tests; wallets not tried on a real device |
| BUH-02.08.00 | 2026-10-17 | branch 836 / 861 / 855 / 891; main 806 / 849 / 803 / 836 (p95 91–134 vs 105–124 ms) | branch 700 / 717 / 704 / 650; main 608 / 709 / 690 / 656 | 0 | 492 passed | 0 vulnerabilities | Independent review of the private admin link: no way in; 2 medium and 6 low findings fixed with tests or documented; no automated scanner here |
| BUH-02.07.00 | 2026-10-16 | branch 880 / 921 / 946; main 876 / 875 / 903 (p95 104–143 vs 133–160 ms) | branch 749 / 721 / 770; main 812 / 714 / 807 | 0 | 464 passed | 0 vulnerabilities | Design and layout change; fit test at 6 phone widths, sideways and 200% text; not seen on a real device |
| BUH-02.06.00 | 2026-10-16 | branch 814 / 872 / 893; main 823 / 735 / 857 (p95 102–156 vs 118–180 ms) | branch 746 / 710 / 753; main 697 / 706 / 783 | 0 | 436 passed | 0 vulnerabilities | Review of stock moves and the app, 8 findings fixed with tests; no real-device install tried |
| BUH-02.05.00 | 2026-10-16 | branch 788 / 826 / 786; main 755 / 830 / 804 (p95 114–175 vs 105–164 ms) | branch 713 / 756 / 626; main 663 / 565 / 628 | 0 | 371 passed | 0 vulnerabilities | Two reviews of updater/proxy, fixed with tests; real containers on Docker, Podman 4.9 and 5.7; Windows line not run on Windows |
| BUH-02.04.00 | 2026-10-15 | branch 848 / 834 / 832; main 842 / 832 / 787 (p95 138–151 vs 92–149 ms) | branch 694 / 701 / 716; main 718 / 677 / 645 | 0 | 303 passed | 0 vulnerabilities | Two reviews (sign-in 6, updater 7 findings), fixed with tests; Windows script not run on a real Windows Podman machine |
| BUH-02.03.02 | 2026-10-15 | branch 831 / 868 / 854; main 839 / 827 / 810 (p95 95–152 vs 100–160 ms) | branch 738 / 665 / 676; main 664 / 663 / 701 | 0 | 255 passed | 0 vulnerabilities | Text-only admin change; no scanner here |
| BUH-02.03.01 | 2026-10-15 | not run: no shop code changed | not run | — | CI full suite | no package changes | not applicable (docs only) |
| BUH-02.03.00 | 2026-10-15 | branch 856 / 832 / 763; main 789 / 792 / 761 (p95 110–180 vs 125–173 ms) | branch 752 / 684 / 698; main 687 / 678 / 643 | 0 | 255 passed | 0 vulnerabilities | Review of autosave and the settings guard, 10 findings fixed with tests; no automated scanner here |
| BUH-02.02.00 | 2026-10-15 | branch 815 / 870 / 772; main 851 / 837 / 789 (p95 175–182 vs 161–175 ms) | branch 587 / 517 / 743; main 515 / 767 / 674 | 0 | 240 passed | 0 vulnerabilities | Money and correctness review, 8 findings fixed with tests; no automated scanner here |
| BUH-02.01.00 | 2026-10-15 | branch 813 / 778 / 796 / 795 / 878 / 867; main 922 / 855 / 860 / 791 / 801 / 751 (p50 70–119 vs 73–105 ms; p95 110–204 vs 114–159 ms) | branch 638 / 640 / 601 / 671 / 646 / 668; main 671 / 652 / 614 / 672 / 725 / 826 | 0 | 231 passed | 0 vulnerabilities | Security and correctness review, 9 findings fixed with tests; no automated scanner here |
| BUH-02.00.00 | 2026-10-15 | branch 681 / 885 / 653 / 796 / 751 / 751; main 824 / 819 / 855 / 803 / 721 / 890 (p50 75–129 vs 72–125 ms; p95 135–272 vs 106–212 ms) | branch 579 / 795 / 586 / 702 / 655 / 699; main 626 / 681 / 727 / 628 / 710 / 717 | 0 | 212 passed | 0 vulnerabilities | Three reviews (security, correctness, email/reset/versions); no automated scanner here |
| BUH-01.02.00 | 2026-10-15 | branch 839 / 891 / 793; main 750 / 868 / 844 (p50 66–76 vs 66–77 ms; p95 104–111 vs 108–140 ms) | branch 657 / 621 / 722; main 606 / 734 / 663 | 0 | 120 passed | 0 vulnerabilities | No scanner here; image smoke-tested in CI (read-only, non-root, no capabilities) |
| BUH-01.01.00 | 2026-10-14 | branch 753 / 662 / 729; main 769 / 729 / 605 (p50 82–88 vs 79–86 ms; p95 139–148 vs 128–210 ms) | branch 568 / 598 / 525; main 591 / 495 / 490 | 0 on the branch (main has no `/api/products`, so its catalogue runs fail by design) | 118 passed | 0 vulnerabilities | Two reviews (security, correctness); no automated scanner here |
| BUH-01.00.00 | 2026-10-14 | branch 707 / 748 / 757 / 751; main 777 / 746 / 759 / 643 (p50 81–87 ms both; p95 136–170 vs 119–152 ms) | branch 598 / 467 / 501 / 497; main 548 / 547 / 622 / 513 (p50 78–100 vs 74–86 ms) | 0 | 76 passed | 0 vulnerabilities | No new scan (not available here) |

**Notes for BUH-02.03.00**
- Three alternating rounds against main at BUH-02.02.00: level (the branch slightly ahead, within run-to-run spread).
- The new readability test reproduced the reported problem on main (labels at 1.12:1 in dark mode) and passes on the branch in light and dark mode at both widths.
- Trying new mail settings against a real mail server was tested with a stand-in; a real Hostinger or Gmail login was not available here.

**Notes for BUH-02.02.00**
- One set of three rounds against main at BUH-02.01.00: all scenarios within run-to-run spread. The review fixes made afterwards touch checkout, orders and settings only, which the load test does not exercise.
- The reported bug (a Dubai customer refused because the laptop reported Virginia) was reproduced on main before the fix.
- Jeebly offers no public serviceability API: delivery is decided from the address and Settings → Delivery; Jeebly's own answer comes when the order is booked.

**Notes for BUH-02.01.00**
- Two sets of three rounds, alternating, against main at BUH-02.00.00. The storefront is level (first set main ahead, second set the branch); courier check and catalogue are within run-to-run spread. Chat itself is only polled while a shopper has it open.
- Reading replies from a real mailbox is tested against a fake IMAP server over TLS; a real Hostinger or Gmail mailbox was not available here.

**Notes for BUH-02.00.00**
- Two sets of three rounds per build, alternating. Courier check and catalogue are level with main. The storefront median is about 8% lower: the home page now also renders the festival theme, the live-update connection and the version badge. The spread is wide on this shared host (main alone 721–890 req/s). Branch rounds 1 and 3 of the first set had the longest tails (p95 up to 272 ms storefront, 365 ms catalogue); neither repeated in the second set.
- The last review fixes (password reset, version requests, updater) change no storefront or catalogue code, so the benchmark was not re-run after them.
- Not run here: Docker itself and Firebase SMS (no daemon, no Firebase project). The container image and the real zero-downtime switch under load run in GitHub Actions on every push.

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
