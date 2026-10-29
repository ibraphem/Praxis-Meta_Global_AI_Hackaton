# Subsequent eight-of-ten run

This directory fixes the missing-input setup for the exported run whose raw result
is 8/10 correct endpoints and 3/5 complete wires. It is a subsequent inference run,
not the frozen 7/10 observation.

- `bundle.json`: byte-for-byte copy of the user's `Downloads/praxis-evaluation-bundle (1).json`. Unlike the other two available exports, this contains the selected SAM masks and all five original endpoint proposals.
- `truth.json`: assembled from the physical-hole labels already recorded in the original benchmark report. The immutable image hash, calibration anchors/revision and selected wire regions were checked. Its analysis ID binds those existing labels to this subsequent run. No hole labels were taken from model predictions or reviewer corrections. Independently marked pixel positions were not available and are not invented.
- `refinement-report.json`: actual offline all-endpoint comparison from the above inputs and the original image. Pixel-error references are explicitly calibration-projected.

From `praxis-frontend`, rerun without creating or overwriting any output file:

```sh
npm run benchmark:refine -- \
  benchmarks/eight-of-ten-2026-10-29/bundle.json \
  benchmarks/eight-of-ten-2026-10-29/truth.json \
  test/fixtures/exact-hole-v1/jumper_wires_breadboard.png \
  --all-endpoints
```

To save a new report, add `--output` with a new filename. Existing files are not overwritten.
No model/network request is made. The original Downloads export, root photograph,
pre-recorded labels and frozen baseline are unchanged.

Measured result: raw 8/10 correct endpoints, refined 2/10; raw 3/5 complete wires,
refined 0/5; 7 correct→unresolved, 1 unresolved→correct, 0 correct→wrong, and 0 wrong-hole
assignments in either pipeline. Acceptance fails; keep the experiment opt-in.
