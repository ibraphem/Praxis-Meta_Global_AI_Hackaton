# Camera demo software verification — 2026-11-02

Scope: synthetic software tests and mocked provider transports. No real SAM/Muse calls were made during implementation. No physical wiring diagnosis or LED-operation acceptance is claimed.

| Check | Result |
| --- | --- |
| Backend unit, HTTP, queue and persistence tests | 292 passed |
| Frontend unit/proxy tests | 149 passed |
| Full browser regression suite | 38 passed |
| Final camera browser rerun after schema/visibility changes | 3 passed |
| Backend and frontend type checks | Passed |
| Backend and frontend production builds | Passed |
| Frontend lint | Zero errors; one existing warning in the untouched connector reference editor |
| Diff whitespace check | Passed |

Tests cover the healthy/released-button case, two wrong strips, verified switch leg aliases, conservative unknown contacts, unsafe/occupied destinations, counterfactual repair, unchanged anchors, forbidden net merges, fresh-image verification, old-image rejection, camera registration and local junction-region changes. The browser tests exercise camera permission denial, immutable capture approval, duplicate-click prevention, linked wire/graph inspection, repair arrows, verification states, restart/resume controls and evidence download.

The bounded HTTP experiment used mocked responses: exactly four SAM requests, then one separately approved endpoint Muse request. No inventory or recovery requests ran. Request intent, every image's pixel dimensions, native checkpoints, transport payloads/responses and hashes were retained. A simulated transport loss persisted unknown usage across a real SQLite reopen; the same operation could not be replayed. Invalid/stale manifests and legacy model retry actions were rejected before dispatch.

A production build initially encountered a sandbox port-binding failure in Turbopack's compiler subprocess. Repeating under expanded permissions retained the failure; moving aside only the generated production build cache allowed the build to succeed. Subsequent production builds passed. No source fallback or framework replacement was required.

The real acceptance test is pending: verify the actual circuit/supply/parts/contact map, freeze its healthy profile, then collect and review distinct healthy, misplaced-J1 and repaired captures. Confirm the LED response physically. Follow [the UI walkthrough](camera-demo.md) and retain each rehearsal's private evidence export.
