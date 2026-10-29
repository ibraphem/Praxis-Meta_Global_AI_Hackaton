# Frozen exact-hole baseline v1

This fixture records the existing 28 October 2026 observation, before local-refinement experiments.
It is not a generated or improved result. Preserve its bytes; the test pins its SHA-256.

- `baseline.json`: all original proposal/review JSON from the supplied report, calibration revision and full geometry, exact logical ground truth, unchanged resolver policy, original nearest-two rankings and distances, rejection reasons, original timings and expected scores.
- `resolver-original.ts.txt`: the pre-change resolver source, with a checksum in the fixture.
- `jumper_wires_breadboard.png` and `praxis-exact-hole-benchmark.md`: byte-for-byte archived copies of the supplied photograph and report; their hashes are recorded and verified. The user's root originals are left intact. Replay reads these archived inputs, so it remains portable without files in Downloads or the repository root.
- The original SAM masks/full scene analysis were **not** included in the report. `selectedSamMasks` is explicitly null. Do not regenerate SAM masks and call them the original inputs; do not reconstruct them from corrected holes. Exact-run refinement comparison remains unavailable until those inputs are recovered.

Expected baseline: 7/10 exact endpoint resolutions, 7/7 resolved precision, 3 unresolved, 0 wrong holes, 2/5 complete wires. Endpoint reversal within a physical wire is allowed. A missing/wrong endpoint prevents complete-wire success. Manual corrections remain archived provenance and never enter original accuracy.

Run `npm run benchmark:replay` from `praxis-frontend`. It performs no network/model calls and writes no fixture changes. New photographs and experimental results belong in separate evaluation bundles, not this fixture.
