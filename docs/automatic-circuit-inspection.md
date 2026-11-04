# Hybrid circuit inspection

The home page and `/camera` combine local OpenCV.js geometry, SAM wire masks,
and Muse semantic identification. The workflow supplies no reference schematic,
fixed component list, expected netlist, or photograph-specific coordinates.

## Use it

1. Capture a clear overhead photograph or upload a JPEG, PNG or WebP under 8 MB.
   Phone camera access requires HTTPS.
2. Select **Analyze circuit**. A browser Web Worker measures the hole grid first.
   The photograph is then sent to the configured Meta provider for wire segmentation
   and component identification. Muse reads printed labels and associates mask IDs;
   it is not asked for terminal coordinates.
3. When there are clear matches, enter a reviewer name and select **Confirm clear
   proposals and save**. This confirms the marked grid, component identities and
   supported connections together. Only exceptions are expanded in the part list;
   **Show every component** exposes the full inventory.
4. For ambiguous matches, check **The identified parts and printed grid labels look
   correct**, then select a suggested hole such as **Confirm A10**. The app offers
   nearby candidates rather than making you type coordinates. A hidden or out-of-frame
   end stays unresolved when there is no supported candidate.
5. Inspect the remaining exceptions, then save the review. Power-rail continuity,
   device polarity and internal module or switch contact mappings need supporting
   information; a grid fit does not establish those facts.

The local grid overlay and original photograph remain visible. Advanced controls
can adjust grid landmarks, register missing rails, reject detections, and add missing
parts or contacts. Adjusting the grid invalidates old connection confirmations and
runs local matching again. A saved human review cannot be overwritten by a late local
measurement. Reopening an inspection does not repeat provider inference.

## Geometry and semantics

- OpenCV.js is pinned to `4.12.0-release.1`, served from this application, and loaded
  only inside a worker when needed. Images are sampled at a maximum 1600-pixel long
  edge for local processing; output coordinates are mapped to the original frame.
- Adaptive thresholding and contour filtering extract visible hole centres.
  Repeated column and row lines identify both terminal banks and the centre channel.
  A robust homography uses measured correspondences, rejects outliers, and reports
  reprojection residual and coverage. Printed text is not treated as a calibrated hole.
- Power-rail geometry is fitted separately to repeated visible hole patterns.
  Registered rails start with **unknown** continuity and unmarked polarity.
- One SAM request supplies bounded, validated wire-mask geometry. One Muse request
  identifies up to 24 parts, reads board numbering/orientation and associates existing
  mask IDs with objects. Its boxes are coarse search regions, not terminal locations.
- Local wire thinning, connected-component checks, lead-line extraction and connector
  footprint measurements produce endpoint references. The calibrated hole resolver
  ranks nearby holes and rejects ambiguous or distant assignments. Cropped ends and
  fragmented/uncertain identities do not become confirmed electrical connections.
- The frontend submits image-bound measurements with an expected revision. The
  backend revalidates image binding, calibration geometry and hole associations.
  All electrical proposals remain unresolved until an explicit human action.
- The existing connectivity engine computes nets from reviewed evidence. Resistors,
  LEDs, switches and unknown assemblies keep separate device ports; no internal
  connection is invented to match an expected circuit.

The supported capture contains one standard ten-column breadboard with 30 or 63
terminal rows. Unsupported layouts, unreadable numbering, blur and occlusion can
still require another photograph or manual correction. Fit residual is an internal
consistency measurement, not an independently measured detection-accuracy percentage.

## Build and run

Install frontend dependencies normally. `npm run dev`, `npm run dev:https` and
`npm run build` run `npm run build:cv` first. This copies the pinned OpenCV runtime
and license and bundles the worker into `public/cv`. Generated files are gitignored;
source, pinned dependencies and lockfile are versioned. Custom deployments must
retain the generated public assets alongside the Next.js application.

The inspection deadline is `CIRCUIT_INSPECTION_TIMEOUT_MS` (default 300 seconds).
Each request uses `CIRCUIT_INSPECTION_REQUEST_TIMEOUT_MS` (default 90 seconds), capped
by `PROVIDER_TIMEOUT_MS`; use a global ceiling of at least 90000 for the full window.
There are no automatic inference retries. Grid measurement, endpoint matching,
review, graph calculation, polling and evidence export make no provider requests.

Inspections and review revisions are stored in the private job SQLite database.
`MAX_STORED_JOBS` and `JOB_RETENTION_HOURS` bound retention. Source photographs and
private evaluation bundles stay outside versioned source.

## Verification and known limits

Unit tests exercise pixel-based extraction, both board sizes, rotation, missing
holes, centre-channel rejection, rail fitting, endpoint mapping, ambiguous masks,
batch review, image binding and stale revisions. Browser tests use the real local
worker and synthetic masks to verify one-action confirmation and unresolved contacts.
Provider responses in automated tests are mocked.

A live test on the supplied photograph returned twelve component hypotheses and
six associated wire masks using two provider requests. Local processing fitted a
30-row grid using 237 observed holes and two unmarked rail patterns. Visual review
shows improved grid alignment over the earlier Muse-coordinate experiment. Wire
contacts in this photograph remain ambiguous or unresolved: there is no claim of a
complete, independently verified circuit reconstruction. Private overlays, raw
provider-run results and local replay results are retained in `benchmark-evidence`.

From `praxis-frontend`, an explicitly authorized live hybrid test can be run with:

```sh
node --env-file-if-exists=../praxis-backend/server/.env --import tsx \
  scripts/inspect-hybrid.mjs IMAGE.jpg OUTPUT.json
```

For offline local endpoint evaluation with an existing bundle, without model calls:

```sh
node --import tsx scripts/replay-hybrid.mjs IMAGE.jpg BUNDLE.json OUTPUT.json
```

Both commands refuse to overwrite an existing output file. The old per-component
Muse-coordinate service and CLI remain for compatibility and comparison; the browser
sends the measured geometry payload and uses the hybrid path.
