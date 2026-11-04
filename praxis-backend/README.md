# Praxis backend

The default camera UI now uses [automatic circuit inspection](../docs/automatic-circuit-inspection.md)
through `/api/circuit-inspections`. Browser-measured OpenCV geometry is combined
with SAM masks and Muse semantic identification; local endpoint measurements and
explicit human confirmations produce the graph. This is separate from the original
perception endpoints described below; it does not assume a fixed circuit.

Praxis's baseline still-image perception returns visible **breadboards, LEDs,
resistors, and jumper wires**. The opt-in [dynamic scene inventory](#dynamic-scene-inventory-release-1-opt-in) adds open-vocabulary object hypotheses and guided segmentation.
This is not yet a circuit verifier. It does not identify breadboard holes, determine
electrical connectivity, track objects between photographs, or establish that a
circuit works.

The frontend now provides **Step A: manual breadboard calibration and logical hole
picking**, independently of this API. Its template-derived grid and user-declared
rail groups are separate from model detections; they are not included in the
analysis response. See the [frontend calibration guide](../praxis-frontend/README.md#breadboard-coordinates--step-a).

The frontend also supports [manual wire endpoint assignments](../praxis-frontend/README.md#wire-endpoints--step-b-manual-assignment)
against that calibrated grid. These photograph-local records are separate from SAM
detections and become stale when their calibration or analysis changes. Wire
identity remains unverified and electrical contact remains unknown. This feature
adds no backend endpoint or automatic connector analysis.

## Requirements and setup

- Node.js **22.13 or later**, with npm. An active Node.js LTS release is recommended.
- A Meta Model API key and access to the configured models. The defaults are
  `sam-3.1` and `muse-spark-1.3`; confirm IDs and availability in your hackathon account.
- A photograph you own or have permission to submit to Meta.

From `praxis-backend`:

```sh
cd server
npm ci
cp .env.example .env
```

Set `META_API_KEY` in `server/.env`, then run:

```sh
npm run dev
```

By default, the service binds to `127.0.0.1:3000`. Missing credentials or invalid
configuration prevent startup. Environment values are never printed in errors.
No mock mode or synthetic detections are used by the running application.

For a compiled build:

```sh
npm run build
npm start
```

`GET /health` returns `{"status":"ok"}`. It is a process health check, not a check
of Meta credentials or model access.

## Recoverable analysis jobs

### Dynamic scene inventory (Release 1, opt-in)

Set `DYNAMIC_SCENE_ENABLED=true` in `server/.env` and restart the backend to enable
open-vocabulary scene discovery for **new persisted analyses**. It is off by default
pending annotated real-photo evaluation. Existing saved analyses and the legacy
synchronous `/api/vision/analyze` contract do not acquire new stages or model calls.

Saved analyses now always show a scene-inventory status. A photograph uploaded with
automatic discovery disabled says **Not run** rather than hiding the panel. Click
**Discover scene objects** to explicitly opt an existing analysis into inventory:
`POST /api/analyses/:id/start-scene` binds its saved SAM checkpoint and makes one
whole-image Muse request, with **zero new SAM requests**. This manual discovery is
available even when automatic discovery is disabled. Its settings and manual origin
are recorded separately; original upload settings, baseline predictions, revisions
and wire reviews remain unchanged. Repeated starts conflict rather than duplicate
inference. An eligible failed inventory still uses the explicit retry action.

Muse-discovered object boxes and proposed labels appear on the photograph as soon
as inventory is saved, including box-only objects. They do not require selection or
successful guided segmentation. Click a scene label or inventory row to inspect its
associated evidence. Unclassified SAM hypotheses remain listed without duplicating
every baseline overlay by default.

The existing broad SAM pass, local coverage audit and interpretation publish first.
Inventory and guided segmentation then run as separate attempts under the same
per-analysis worker lease. They are serialized with baseline work, not executed in
parallel within one job. This preserves existing model admission and makes baseline
results available before the optional stages. Inventory can run after a broad-pass
failure, and inventory failure never removes a published baseline result.

Muse independently inventories the whole photograph using dynamic descriptions and
broad organizational categories. It is not given the four baseline component labels.
Unknown devices, power sources, connectors and visible external conductors can remain
box-only hypotheses. Eligible SAM observations absent from the inventory become
unclassified hypotheses. Quarantined recovery masks remain excluded.

`scene.graph` separates physical-object hypotheses, immutable visual observations,
and proposed associations. Multiple observations can support one hypothesis, and
one observation can support competing hypotheses. Category/overlap matching and a
guided prompt do not establish physical identity. The graph is separate from legacy
component counts, wire selection, calibrated holes and endpoint reviews. All new
recognition/association claims remain proposed or unknown; electrical connections
remain unestablished. Terminal inference and relationship verification are later
releases.

Guided segmentation prioritizes missing connectors, conductors, power sources and
unknown devices before other components. Existing mask candidates suppress redundant
requests for their associated hypotheses. Boards are kept box-only in this stage.
Each request uses a short phrase on an expanded original-resolution object crop;
all results are projected back to original-image `[x,y,width,height]` coordinates.
This release uses phrase-plus-crop prompting; point/box prompt comparisons remain
experimental. Returned masks are candidate associations, not prompt verification.

Defaults are **three guided requests**, **six million cumulative crop pixels**, and
**two million pixels per crop**. `SCENE_MAX_GUIDED_REQUESTS=0` enables inventory only.
`SCENE_STAGE_TIMEOUT_MS=45000` bounds each inventory/guided stage. Settings are frozen
when uploading. Oversized crops and work beyond the budget remain not attempted;
empty responses, failed requests and interrupted work have distinct recorded states.
Requests and crop pixels are charged before dispatch. Unknown upstream outcomes stop
further guided dispatch, with no automatic retries. Guided requests do not consume or
reset the existing wire-recovery budget.

Each new stage and guided request has persisted attempt/binding/timing evidence.
Scene checkpoints are immutable and hash checked, retaining original native masks
privately and bounded safe SVG previews publicly. IDs are UUIDs independent of labels
and array order. Exact persisted SAM evidence retains observation identity; a new
Muse inventory attempt creates fresh object hypotheses rather than silently reusing
semantic identity. Scene updates do not change the legacy analysis revision or
invalidate its endpoint assignments.

`POST /api/analyses/:id/retry-scene` explicitly retries a failed inventory attempt.
Prior attempts/checkpoints remain saved. Guided request retries are not exposed in
this release, and `retry-muse` still makes zero SAM/inventory requests. Restarted
workers mark interrupted scene work unknown rather than redispatching it.
`evidence:export` includes scene checkpoints and private native masks. The workspace
shows hypothesis labels, selected boxes/masks, competing associations, unresolved
states, incremental stage times and guided request/pixel usage. No monetary estimate
is fabricated without billing evidence.

Before enabling by default, freeze an independently annotated battery/connector/lead
photo set and compare the baseline and dynamic modes using the same model settings
and configured budgets. Measure object recall, unknown-object discovery, incorrect
splits/merges and association precision separately from distinct physical-wire
coverage, complete masks and endpoint accuracy. Include unresolved cases in the
denominators and report incremental requests, crop pixels and stage latency. Release
1 does not claim improved terminal coverage or electrical connectivity. Synthetic
contract/browser tests verify behavior, not real-photo recognition accuracy.

### Reconciled object view and terminal proposals

The workspace now defaults to **Objects** when a scene inventory exists. It presents
one primary label per reconciled display group, using named object hypotheses rather
than anonymous S markers. Original SAM/Muse objects, observations and stable IDs stay
saved. **Evidence** exposes baseline candidates, masks, fragments, search regions and
alternative identities. Selecting an object also exposes its candidate masks and
terminal positions. Approximate Muse locations, SAM candidate geometry and confirmed
physical boundaries are explicitly distinguished; this release confirms no boundary.

Reconciliation uses semantic compatibility, body/assembly containment and spatial
evidence. Wire containment alone never establishes wire identity. Ambiguous matches
remain unresolved, overlap chains do not merge arbitrarily, and bodies/housings keep
separate `part_of` hypotheses. Display grouping does not verify physical identity.
The read-only projection works on old v1 scene snapshots. **Record reconciliation**
(`POST .../reconcile-scene`) records a new v2 checkpoint without a model request or
modifying earlier snapshots, baseline predictions, revisions or endpoint reviews.

Each multi-member display group states **Grouped by proposal** or **Confirmed same
object**. Original member IDs, source descriptions and boxes remain inspectable;
**Show separately** displays members individually without changing stored evidence.
The same local endpoint accepts an optional `identityReview: { relationId, decision }`
with `same_object`, `different_objects` or `uncertain`. Reviews append a human-review
ledger entry bound to the input checkpoint and timestamp; the latest pair review
controls grouping even if another model proposal repeats that pair. Confirming
identity never confirms terminals, roles, apparent attachments or electrical contact.

**Selective terminal discovery** (`POST .../discover-terminals`) is an explicit bounded model
action. It starts with battery snap connectors and LED holders/assemblies; selected
inventory objects can be inspected individually. Default suggestions exclude
conductors, boards and unknown categories, including wires whose descriptions mention
a snap connector or LED holder. A grouped object requires explicit inventory-member
selection. The coverage panel distinguishes not attempted, queued/failed requests,
examined but unresolved, and visible contact proposed. Each object uses one Muse request
with untouched full-scene context and a native focused crop. All points are projected
from crop coordinates to original-image pixels. Terminal identity, physical kind,
position, printed pin label and electrical role are separate fields. Hidden positions
stay null; role proposals require a reported visible marking, never wire color.
The `physical-terminals-v2` prompt can return separate crop-projected reference points
for exposed conductive leads or insulated wire/housing junctions. These use distinct
markers and never locate a hidden contact or justify a visible attachment. Historical
v1 lead coordinates remain readable without being promoted to contact locations.
Apparent attachments distinguish visible attachment, occluded path, proximity and
insufficient evidence. None creates electrical connectivity or a verified terminal.

**Segment scene targets** (`POST .../guide-scene`) explicitly enables a cumulative
budget of three guided SAM requests and six million crop pixels on a saved scene,
including inventory-only analyses. The body binds `snapshotId`, `snapshotHash`,
`objectIds` (one to three unattempted objects) and
`guidedBudget: { maxRequests: 3, maxPixels: 6000000 }`. Prior request/pixel charges
are retained. Priority is battery snap connector, LED holder/housing, then an
unsegmented conductor; the existing per-crop limit also applies. Unknown execution
stops dispatch and is never retried automatically. Baseline SAM results are preserved.

**Refresh inventory** (`POST .../refresh-scene`) binds the current scene checkpoint
and makes one whole-image Muse request. It does not automatically queue guided SAM.
Refresh appends observations and preserves existing objects, observations,
associations, terminal/attachment claims, identity decisions and native scene masks.
Rediscoveries reuse an object ID only for a unique reciprocal semantic/spatial match.
Conductors require matching descriptions and strong spatial support; ambiguous or
renamed wire hypotheses retain separate IDs. Omitted objects remain available.
Capacity failure retains earlier evidence rather than truncating the graph.

Guided response masks are proposals for the prompted object, never verified by
box overlap. `reconcile-scene` accepts a local `maskReview` with exact `objectId`,
`observationId`, `decision` (`accepted`, `rejected`, `uncertain`), `source`
(`human_review`, `assistant_visual`) and a visible-evidence `reason`. Reviews bind
the input checkpoint and are append-only. Assistant visual assessment remains
explicitly distinct from human review; neither establishes terminal polarity,
a confirmed boundary or electrical continuity. Evaluation bundles retain this ledger
and its observation/object associations separately from identity grouping decisions.

Both actions require the exact current scene checkpoint ID/hash. Terminal requests
default to two cumulative requests and four million crop pixels per analysis;
`SCENE_MAX_TERMINAL_REQUESTS=0` disables dispatch. Charges and input bindings are saved
before provider execution. A failure stops further dispatch, preserves earlier
results and does not trigger retries. Interrupted/unknown work stays recorded and
cannot be silently repeated. Existing baseline analysis and wire budgets are unchanged.

See the [independent annotation and scoring workflow](benchmarks/scene-v2/README.md)
for `scene:score`, including recall, duplicate/merged identities, terminal error,
false attachment proposals and measured attempt latency. No new accuracy claim is
made without independently annotated real photographs.

### Persisted baseline job API

The frontend uses a persisted job API. Run on Node.js **22.13 or later** for built-in
[`node:sqlite`](https://nodejs.org/download/release/v22.13.0/docs/api/cli.html#--no-experimental-sqlite).
The existing synchronous `/api/vision/analyze` endpoint remains for compatibility.

- `POST /api/analyses`: one multipart `image`; validates and saves the photograph,
  then returns **202** with `analysisId`. Provider execution starts independently.
- `GET /api/analyses/:id`: saved state, stage attempts, diagnostics, and the latest
  full result or explicit `sam-only` partial result. Poll every 1.5 seconds.
- `GET /api/analyses/:id/image`: original uploaded bytes for reopening the workspace.
- `POST /api/analyses/:id/retry-muse`: explicit interpretation retry using the exact
  saved SAM snapshot. **Zero SAM calls**, including missed-wire recovery. Missed
  wires remain unresolved search regions. No original attempt/result is replaced.
- `POST /api/analyses/:id/retry-sam`: explicit segmentation retry after a failure.
- `DELETE /api/analyses/:id`: remove a saved inactive job and its photograph.

All routes use the existing backend authentication, origin rejection, and no-store
policy. This remains a local evaluation application: the shared backend token does
not provide per-user ownership or authorization for public deployment.

Each attempt has an immutable ID and transitions `queued → running → succeeded`,
`timed_out`, `interrupted`, or `failed`. Status is separate from `retryPolicy` and
`upstreamOutcome`: a local timeout or worker interruption means upstream execution
is **unknown**, not cancelled. Terminal failures require an explicit manual retry;
no interrupted/timed-out attempt is automatically put back in the queue. An already
queued, unsent attempt can be dispatched after a restart. Definitive input errors
are not retryable; configuration/provider failures may be retried manually after
addressing the cause. Concurrent retries return 409 rather than duplicate work.

SQLite commits photographs, original-resolution SAM candidates/native masks,
reviewable SVG geometry, settings/model IDs, and attempt history. Worker claims are
transactional, renewed every 3 seconds with a 15-second lease. Expired running
attempts become interrupted; graceful shutdown interrupts immediately. Attempt and
owner checks fence stale completions. Multiple processes sharing the **same local
SQLite database** share job capacity; configure the same `JOB_WORKER_CONCURRENCY`
in each process. It defaults to **1**, independently of the legacy
`MAX_CONCURRENT_ANALYSES=2` limit. SAM may still use `SAM_CONCURRENCY=2` within one
job. Legacy endpoints and rate limits keep their separate admission limits.
This is a bounded worker inside the long-running backend, not a serverless task or
an external queue. Keep the backend running and mount durable local storage.

`ANALYSIS_JOB_DIR` defaults to `.praxis-jobs` relative to the backend working directory
and is gitignored. New directories use 0700, the database 0600. Defaults retain up
to 100 jobs for 24 hours and at most 20 attempts per stage. Expired inactive jobs
are cleaned by the worker/admission path; active jobs finish before cleanup. A full
store rejects new uploads rather than silently evicting another user's work.
Database deletion removes application access, not a forensic erasure guarantee.
Browser pause/disconnect does not cancel server execution or delete persisted data.

Each completed SAM checkpoint has an immutable `samSnapshotId`, a canonical content
hash, source attempt ID, image hash, model ID and `sam-checkpoint-v1` processing
version. Native checkpoint payloads are stored separately from mutable job state;
SQLite rejects updates to checkpoint rows. Every queued Muse attempt binds to one
checkpoint before dispatch, and inference loads that bound checkpoint rather than
whatever checkpoint is currently attached to the job. Historical Muse results are
preserved with their attempt bindings in private evidence exports. New partial/full
results include checkpoint provenance, so browser evaluation bundles retain it.

Older saved jobs are migrated without rerunning SAM/Muse or changing original
predictions, geometry, or completion timestamps. Their current checkpoint receives
`origin: legacy_import`; historical attempt bindings are labelled `legacy_inferred`
because the original format cannot independently prove each historical association.
New attempts use `snapshotBinding: recorded`.

SAM-only objects are explicitly `uncertain`, `sam_unverified`, and ineligible for
automatic electrical guidance. Breadboard detections are labelled **board regions**,
not confirmed physical boards. The reviewer can manually calibrate the photograph
and assign endpoints. Muse completion creates a new review run identity, so previous
endpoint associations cannot silently attach to renumbered candidates.

Muse uses one attempt, with the default 45-second provider deadline; SAM retains its
configured transient retry policy. `ANALYSIS_TIMEOUT_MS` now also bounds each worker
stage. Changing image size/prompt is experimental: defaults preserve the original
input and prompt. `MUSE_MAX_DIMENSION=1280` (or `1024`) makes a separate JPEG at quality
82; SAM, calibration, and dedicated endpoint input remain at original resolution.
Candidate boxes are transformed into the resized input frame. Normalized Muse
outputs are projected directly into the original frame, without double scaling.
`MUSE_MINIMAL_PROMPT=true` defers missed-wire search but keeps candidate validation
and physical-board grouping safeguards. Job settings are frozen when uploaded.

### Controlled Muse timeout comparison

After a job has saved SAM results and no active/queued Muse attempt, from `server`:

```sh
npm run experiment:muse -- ACTUAL_ANALYSIS_UUID --output new-muse-comparison.json
```

The experiment takes a transactional, renewable reservation before any provider
request. It refuses to start while a job or legacy request is active. While held,
workers sharing this database pause new claims, manual retries conflict, and legacy
analysis/endpoint routes reject new model admission. New photo uploads can still
be saved and queued. A second experiment cannot reserve concurrently. This gate
covers backend instances using the same updated store; other applications/accounts
or instances using another database remain outside it.

A lost lease or stopped process marks the reservation interrupted and blocks further
model admission until explicitly released. Recover the experiment ID from the saved
analysis status or partial report, inspect the retained measurements, then run:

```sh
npm run experiment:muse -- --release INTERRUPTED_EXPERIMENT_UUID
```

Release is a manual acknowledgement of uncertainty; it does not cancel or prove the
termination of upstream execution. There is no automatic experiment retry. A variant
that reaches a local deadline records `upstreamOutcome: unknown`; the experiment
now stops before dispatching another variant. Its reservation remains interrupted
until explicitly released. Reports preserve every attempted variant and prior success.

The default plans **up to three provider requests**, sequentially, without automatic
retries: original/current prompt, 1280/current prompt, 1280/minimal prompt. It reuses
the same saved SAM snapshot and model; it preserves the source job and every
prediction. The report records the image/snapshot hashes, settings, success or
failure, latency, results and diagnostics. Do not repeatedly rerun until success.
Three observations are exploratory, not an accuracy or availability estimate.

### Preserve benchmark evidence beyond job retention

Keep the 24-hour storage default for ordinary sessions, or set
`JOB_RETENTION_HOURS=168` for seven days of local evaluation. This affects newly
created jobs; it does not silently extend existing expiration dates. Export evidence
before expiry. Running/interrupted experiment reservations protect their source job
from deletion until completion or explicit release.

From `server`, use the actual analysis ID from the saved page URL:

```sh
npm run evidence:export -- ACTUAL_ANALYSIS_UUID benchmark-evidence/NEW_ARCHIVE_NAME
```

This offline command makes **zero provider requests**. It creates a new private,
gitignored directory containing original photograph bytes, job/attempt history,
immutable native SAM checkpoints, experiment reports, and a SHA-256 manifest.
It refuses to overwrite an existing archive. These files survive job-store cleanup.

Reviewer calibration, endpoint corrections and independent ground truth are browser
state or external evidence; the backend cannot reconstruct them. To include files
you have already exported/recorded, append `--bundle /actual/path/to/evaluation.json`
and `--truth /actual/path/to/ground-truth.json`. Attachment bytes are copied exactly;
available image/run identity fields are checked. Missing annotations are recorded
as missing, and model predictions are never manufactured into ground truth. This
job evidence archive is distinct from the frontend evaluation bundle consumed by
`benchmark:refine`; keep that bundle and its photograph when running refinement.

Per-request diagnostics include stage/model, actual image dimensions, encoded image
and full JSON payload bytes, prompt character count, configured output-token budget
(or null when provider-default), response-header latency when available, total
latency, retry number, timeout type, status, and an allowlisted provider request ID.
Photographs, prompts and raw responses are never written to diagnostic logs.

## Analyze a photograph

`POST /api/vision/analyze` accepts `multipart/form-data` containing exactly one file
field named `image`, with no additional fields. Supported contents: single-frame
JPEG, PNG, or WebP. Filenames and MIME declarations do not establish validity;
the image signature and decoder are checked.

Select your photograph in the Praxis frontend at `http://localhost:3001` and
choose **Analyze image** to inspect detections overlaid on the photograph.
See [`../praxis-frontend/README.md`](../praxis-frontend/README.md) for setup.
For a direct API request, replace `/absolute/path/to/photo.jpg` below with your
own local photograph; no photographs are stored in this repository.

From `praxis-backend/server`:

```sh
curl --fail-with-body http://127.0.0.1:3000/api/vision/analyze \
  -F 'image=@/absolute/path/to/photo.jpg'
```

If `PRAXIS_API_TOKEN` is configured, export the same token in your shell and include:

```sh
curl --fail-with-body http://127.0.0.1:3000/api/vision/analyze \
  -H "Authorization: Bearer $PRAXIS_API_TOKEN" \
  -F 'image=@/absolute/path/to/photo.jpg'
```

Illustrative response, not a measured detection:

```json
{
  "image": { "width": 1280, "height": 720 },
  "objects": [
    {
      "id": "led_1",
      "type": "led",
      "bbox": [120, 85, 35, 60],
      "color": "green",
      "confidence": 0.91,
      "interpretation": "confirmed"
    }
  ],
  "provenance": {
    "mode": "combined",
    "segmentationModel": "sam-3.1",
    "reasoningModel": "muse-spark-1.3"
  }
}
```

### Response contract

- `type` is `breadboard`, `led`, `resistor`, or `jumper_wire`.
- `bbox` is **[x, y, width, height] in pixels** of the orientation-corrected image,
  with a top-left origin. Width and height are positive; all boxes fit the image.
  Input resolution is preserved. Scale against the returned image dimensions
  when drawing an overlay, and apply the same EXIF orientation to the preview.
- `id` identifies an object within this response. It is not a tracking ID.
- `color` is omitted when unknown.
- `confidence` is an optional, uncalibrated **SAM detection score**, not electrical
  correctness or Muse's certainty. Muse never supplies a score. A Muse-proposed
  wire refined successfully by SAM may carry SAM's score.
- `localizationSource` identifies geometry from `sam`, `muse`, or `derived`
  (an enclosing box calculated from grouped SAM breadboard regions).
  `detectionSource` distinguishes SAM discovery from Muse-proposed wire recovery.
- `interpretation` is Muse's visual judgment: `confirmed` or `uncertain`. Neither
  proves a connection is electrically sound. Recovered wires remain uncertain.
- Each `jumper_wire` in `objects` requires `geometryStatus: "segmented"` and a
  `mask: {format: "svg_path", width, height, path}`. The path uses mask-local
  coordinates: translate to `bbox.x,y`, then scale by `bbox.width/mask.width`
  and `bbox.height/mask.height`. Rectangles remain useful for layout, not for
  selecting an individual wire. Other categories remain box-only.
- `proposals` contains unresolved search regions, each with a separate
  `wire_region_N` ID, pixel `bbox`, `refinementStatus`, `reason`, and optional
  `refinementCode`. Regions may contain multiple wires or duplicate observations;
  they are **not individual wire detections** and do not contribute to wire counts.
- Wire candidates have `identityStatus: "unverified"` and
  `guidanceEligible: false`. Every proposal also has `guidanceEligible: false`.
  This milestone does not authorize physical-action instructions or establish
  persistent wire identity. IDs reset with each response.
- `provenance.wireAudit` records `samCandidates`, `acceptedSam` (usable masks after
  review), `recoveredByMuse` (successful SAM refinements of Muse proposals),
  `regionsProposedByMuse`, `refinementAttempts` (regions submitted in one batch),
  and `unresolvedRegions`.
- An empty `objects` array means no detections passed the checks. Inspect
  `proposals` and `breadboardAudit.unresolvedCandidateIds` too; an empty result
  does **not** prove components are absent.

This is Praxis's schema, not the native Meta response format. Primary SAM/Muse
failures remain errors. Optional wire refinement is explicitly best effort:
failures retain the primary results and unresolved regions with a reason/code.

## Breadboard instances and board sections

In combined mode, SAM searches for a complete solderless breadboard. It can still
return terminal strips or rail sections as separate regions. Preserve all of those
candidates through deduplication: box overlap alone does not establish board identity.

The existing Muse review now returns `breadboardCandidates` (one `whole`, `part`,
or `uncertain` extent per SAM board candidate, including rejected ones) and
`breadboardGroups` (candidate IDs, optional whole-candidate ID, and a confirmed or
uncertain visual grouping). It sees the same photograph; this adds no model round
trip. The prompt explicitly distinguishes attached rail/terminal sections from
separate adjacent or overlapping boards.

Only groups with confirmed membership and confirmed, known-extent candidates
become breadboards in `objects`. A single part cannot become a complete board.
Invalid IDs, duplicate membership, missing extent reviews, rejected group members
and invalid whole-candidate references fail with `INVALID_PROVIDER_OUTPUT`.

When a whole-board SAM region encloses every member, keep that region's original
box and optional SAM score. Otherwise calculate the union of the member boxes,
set `localizationSource: "derived"`, and omit `confidence`. A derived box is an
approximate enclosure, not a newly segmented full board or verified calibration.
No averaging or maximum of section scores becomes a physical-board confidence.

Each consolidated object includes `breadboardGrouping` with `candidateIds`,
`geometrySource: "sam_candidate" | "candidate_union"`, `wholeCandidateId` (or
null), and `reviewSource: "muse"`. The separate `breadboardAudit` retains every
original SAM board candidate's pixel box, optional score, review decision and
extent under `sam_breadboard_N` IDs. These IDs describe evidence, not additional
physical boards. `unresolvedCandidateIds` identifies accepted regions that could
not be consolidated reliably. Rejected regions remain diagnostic-only.

Backend and frontend validate bounded arrays, image bounds, unique membership,
reference coverage, exact derived boxes and score provenance. Every accepted
region must belong to exactly one displayed board or the unresolved list. The UI
counts only consolidated objects and exposes unresolved board regions separately.
Legacy responses without grouping metadata remain readable by the frontend.
Reasoning-only mode retains its existing Muse-only contract and complete-board
prompt; SAM-region consolidation applies to combined mode.

Grouping is still a model judgment. There is no proximity-only merge, forced
single-board count, added breadboard SAM refinement, or automatic link to manually
calibrated board IDs. Unit/integration fixtures cover four fragments, whole-plus-
part detections, separate adjacent boards, ambiguity and invalid output; they do
not establish accuracy on a real photograph. Reanalyze after restarting both
services (rebuild first for production) to evaluate the changed prompts on photos.

## Pipeline and account capabilities

The default `VISION_MODE=combined`:

1. Validate and fully decode the image; correct orientation, flatten transparency
   onto white, strip metadata, and encode JPEG in memory.
2. Send four separate SAM requests, one per supported concept. Requests are
   bounded by `SAM_CONCURRENCY` (two at a time by default). Use compact masks
   and request confidence. A failed category cancels and settles sibling requests
   before the analysis slot is released; no partial result is returned.
   For jumper wires, the SAM noun phrase is `wire`; the more specific phrase
   `jumper wire` missed visible wires in a live prompt comparison. Muse filters
   bare component legs, printed rail markings, and other non-jumper candidates.
3. Parse SAM's native single-image grammar and inclusive pixel corners. Retain
   encoded masks internally for wires only; decode with the official
   `@meta-sam/parser` package. Raw encoded masks and provider object IDs never
   cross the public API.
4. Suppress near-identical LED/resistor boxes and assign candidate IDs. Preserve
   overlapping SAM wire boxes (curved wires can share a rectangular area) and
   breadboard regions (whole/part relationships need semantic review).
5. Muse receives the original prepared image and candidate boxes. It reviews
   every candidate and independently proposes at most 16 missed-wire search
   regions on its normalized 0–1000 grid. Each proposal includes up to three
   positive points on one wire and up to three negative points to exclude
   neighbors. If no trustworthy point is visible, Muse supplies no positive
   anchor and the region stays unresolved.
   In that same call it reviews breadboard extents and grouping; consolidate
   supported groups and retain unresolved board regions separately.
6. Check the accepted primary wire masks. Select up to `MAX_WIRE_REFINEMENTS`
   anchored Muse regions and convert their boxes/points into original-image
   pixels. Submit one native spatial-prompt SAM batch (box + positive/negative
   points, without a text concept). It has its own bounded deadline, no retries,
   and stays inside the overall analysis deadline.
7. Require nonempty, predominantly connected, wire-like masks with a plausible
   two-ended path, seed consistency, and no near-duplicate accepted geometry.
   Reject blobs, branches, disconnected masks and prompt mismatches as unresolved
   regions. These conservative checks can also reject valid occluded or clipped
   wires; passing them does not prove that a mask is one physical wire.
8. Expose usable contours as SVG path geometry; keep failures as separate regions.
   Validate IDs, image bounds, geometry quotas and confidence provenance before
   assigning final response-local object IDs.

Mask work is bounded: 4 million pixels per mask, 12 million cumulatively per
analysis, 6,000 contour boundary edges before path tracing, 18,000 path characters
per object and 120,000 total. Geometry simplification preserves thin contours;
only numeric `M`/`L`/`Z` path data is returned, never SVG markup or URLs. Optional
refinement adds at most one Meta request and defaults to 15 seconds. Setting
`MAX_WIRE_REFINEMENTS=0` disables that extra request, while still inspecting
primary SAM masks.

### Wire regression check

A live prompt comparison on an approved, already annotated circuit crop found
zero detections for `jumper wire` versus ten for `wire`. A live run of the mask
pipeline retained seven segmented wire candidates and six unresolved regions;
three Muse regions were submitted to SAM but remained ambiguous. The run took
51.9 seconds: Muse review used 43.7 seconds and spatial SAM refinement 3.0 seconds.
A rendered contour overlay was checked for alignment against that crop. These
numbers describe one annotated image, not general detection accuracy, wire count
accuracy, or correct electrical connections. Evaluation photographs and output
are not committed to this repository.

If your account has Muse but lacks SAM, explicitly set:

```dotenv
VISION_MODE=reasoning-only
```

This mode asks Muse to locate supported components on its 0–1000 coordinate grid,
converts boxes to pixels, and returns no segmentation confidence. Wire observations
are unresolved `proposals` with reason `sam_unavailable`, rather than numbered
wire objects. It is a distinct
perception path, not equivalent to SAM segmentation. A failed combined-mode call
does not switch modes. If your hackathon API differs from these documented
contracts, adapt the provider services rather than bypassing validation.

Official integration references:

- [SAM prompts, confidence, and non-streaming requests](https://dev.meta.ai/docs/sam/segmenting)
- [SAM output grammar](https://dev.meta.ai/docs/sam/reading-segmentation)
- [Muse image understanding and coordinates](https://dev.meta.ai/docs/image-understanding)
- [Structured output](https://dev.meta.ai/docs/structured-output)

## Configuration

All settings are environment variables. `server/.env` is loaded by the npm scripts;
existing environment variables take precedence. The real `.env` is ignored by Git.

| Variable                  | Default                  | Purpose                                                                                                   |
| ------------------------- | ------------------------ | --------------------------------------------------------------------------------------------------------- |
| `META_API_KEY`            | Required                 | Server-side Meta credential                                                                               |
| `META_BASE_URL`           | `https://api.meta.ai/v1` | Trusted administrator-configured HTTPS endpoint; no redirects                                             |
| `META_SAM_MODEL`          | `sam-3.1`                | Account-accessible SAM model                                                                              |
| `META_REASONING_MODEL`    | `muse-spark-1.3`         | Account-accessible Muse model                                                                             |
| `VISION_MODE`             | `combined`               | `combined` or `reasoning-only`                                                                            |
| `HOST` / `PORT`           | `127.0.0.1` / `3000`     | Bind address and port                                                                                     |
| `NODE_ENV`                | `development`            | `development`, `test`, or `production`                                                                    |
| `PRAXIS_API_TOKEN`        | Unset                    | Separate bearer token, 32–256 characters                                                                  |
| `MAX_UPLOAD_BYTES`        | `8388608`                | 8 MiB input file limit                                                                                    |
| `MAX_IMAGE_PIXELS`        | `16000000`               | Maximum decoded pixels                                                                                    |
| `MAX_CONCURRENT_ANALYSES` | `2`                      | Per-process upload/decode/inference slots; excess requests rejected                                       |
| `MAX_WIRE_REFINEMENTS`    | `6`                      | Maximum Muse regions in the optional spatial SAM batch (0–16)                                             |
| `REFINEMENT_TIMEOUT_MS`   | `15000`                  | Optional batch deadline (maximum 45000), capped by provider and overall budgets; no retries               |
| `JOB_WORKER_CONCURRENCY`  | `1`                      | Concurrent persisted job stages across workers sharing the same database; independent of legacy admission |
| `SAM_CONCURRENCY`         | `2`                      | Maximum simultaneous SAM concept calls per analysis (1–4)                                                 |
| `ANALYSIS_TIMEOUT_MS`     | `180000`                 | Overall upload/analysis deadline (maximum 300000)                                                         |
| `PROVIDER_TIMEOUT_MS`     | `45000`                  | Per-attempt provider deadline, including response reading (maximum 120000)                                |
| `PROVIDER_MAX_RETRIES`    | `1`                      | Extra SAM attempts for network failures, timeouts, HTTP 429 and 5xx; Muse uses zero                       |
| `RATE_LIMIT_MAX`          | `20`                     | Requests per client IP per window                                                                         |
| `RATE_LIMIT_WINDOW_MS`    | `60000`                  | Rate-limit window                                                                                         |

## Security and privacy

- A bearer token is required in production and whenever binding beyond loopback.
  Generate a distinct random token, for example with `openssl rand -hex 32`.
- Authentication precedes image processing. Token comparisons use fixed-length
  hashes and constant-time comparison. Use TLS at the deployment boundary.
- Browser Origin requests are currently rejected, and CORS is disabled. Add an
  explicit origin allowlist when integrating the frontend. A shared backend token
  is not a substitute for user authentication in a public application.
- The job API persists original photographs, masks and results in its private local
  SQLite store for recovery. Legacy synchronous uploads remain memory-only. Image
  metadata is stripped before provider submission, but **the photograph is sent to
  Meta**; provider handling depends on your account's terms. Local retention and
  deletion are described above.
- File size, decoded pixels, multipart fields, request duration, response size
  (16 MiB per provider response), rate, and concurrent analyses are bounded.
- There is no user-supplied URL fetch, tool execution, or model-generated code
  execution. Text in photographs is explicitly treated as untrusted scene data.
- Request bodies, photographs, tokens, filenames, raw model output, and error
  stacks are not logged. Structured logs contain request IDs, fixed stage names,
  configured model IDs, attempt numbers, timings, safe error codes and statuses.
  Responses use `Cache-Control: no-store`.
- Rate limiting and concurrency limits are per process. Multi-instance deployment
  needs shared admission/rate controls. `trustProxy` is disabled; configure trusted
  proxies explicitly before relying on forwarded client addresses.

## Errors

Errors have the shape:

```json
{
  "error": {
    "code": "INVALID_PROVIDER_OUTPUT",
    "message": "The vision provider returned an invalid result.",
    "requestId": "server-generated-request-id"
  }
}
```

| Status        | Meaning                                                                  |
| ------------- | ------------------------------------------------------------------------ |
| `400`         | Missing image, malformed multipart, incorrect/extra fields               |
| `401` / `403` | Missing/invalid bearer token or disallowed browser origin                |
| `413`         | Upload size or decoded pixel budget exceeded                             |
| `415`         | Wrong request content type or unsupported image contents                 |
| `422`         | Corrupt or multi-frame image                                             |
| `429`         | Local rate limit                                                         |
| `499`         | Client or upstream peer cancelled/disconnected                           |
| `502`         | Provider/network failure or invalid/incomplete provider output           |
| `503`         | No local capacity, provider rate limit, or credential/model access issue |
| `504`         | Provider or overall deadline exceeded                                    |

## Diagnose a timeout

Restart both services after updating. Existing environment overrides take
precedence over the new defaults. If using `npm start`, rebuild before restarting.
The frontend must allow more time than the backend: defaults are **45 seconds per
Meta attempt, 180 seconds per backend analysis, and 190 seconds at the proxy**.
SAM allows its configured transient retries. Initial Muse interpretation has one
attempt with no automatic retry, including after a deadline expiration. The legacy
overall deadline and each worker stage remain bounded. These limits reduce premature timeouts, not provider latency.
The backend's idle socket limit stays 15 seconds beyond its analysis budget;
the separate incoming-upload deadline remains 15 seconds.

Every analysis returns a request ID in `X-Request-Id`; errors also include it in
`error.requestId`, and successful responses include it in `diagnostics.requestId`.
The Next proxy generates this ID and forwards it to the backend. Direct API
clients can supply a valid UUID v4; invalid values are replaced. An ID is for
correlation, not authentication.

| Code                | Actual source                                                                                                |
| ------------------- | ------------------------------------------------------------------------------------------------------------ |
| `PROVIDER_TIMEOUT`  | Backend's per-attempt timer expired while awaiting or reading a Meta response                                |
| `META_API_TIMEOUT`  | Meta returned HTTP 504; its own internal deadline is unknown                                                 |
| `ANALYSIS_TIMEOUT`  | Backend's overall analysis deadline expired                                                                  |
| `PROXY_TIMEOUT`     | Next.js server's own deadline expired; emitted by the frontend proxy                                         |
| `REQUEST_CANCELLED` | Client or upstream peer disconnected/cancelled; HTTP 499 rather than 504                                     |
| `BACKEND_TIMEOUT`   | Proxy received HTTP 504 without recognized diagnostics, for example from an older backend or another gateway |

An illustrative provider timeout (durations are examples, not a measured run):

```json
{
  "error": {
    "code": "PROVIDER_TIMEOUT",
    "message": "The backend timed out waiting for a Meta model response.",
    "requestId": "de07b66f-f185-4dbc-80eb-e20c5c343f14",
    "details": {
      "source": "backend_provider",
      "stage": "sam.led",
      "phase": "awaiting_response",
      "model": "sam-3.1",
      "attempt": 2,
      "elapsedMs": 45001,
      "timeoutMs": 45000,
      "totalElapsedMs": 91000,
      "timings": []
    }
  }
}
```

`elapsedMs` is the duration at the failing source (one attempt for a provider
deadline); `totalElapsedMs` is total backend duration. `activeStages` captures all
work in flight when the overall deadline fires, including parallel SAM calls.
`phase` distinguishes waiting for response headers from reading the response body.
Waiting for headers can include connection, upload, queueing and inference; it does
not isolate Meta's internal compute time.

Actual responses include a bounded `timings` array with start offsets, durations,
outcomes and attempt metadata. Each entry's `kind` distinguishes normal work,
model requests and retry delays. Successful analyses also return a `diagnostics`
object containing the same timings, so slow successes can be inspected too.

In the backend terminal, follow JSON events `vision.analysis_started`,
`vision.stage_started`, `vision.stage_finished`, `vision.provider_retry`, and
`vision.analysis_completed` or `vision.analysis_failed`. Filter by request ID;
the frontend terminal logs the same ID. Stage names identify `sam.breadboard`,
`sam.led`, `sam.resistor`, `sam.jumper_wire`, `muse.interpret`, `muse.detect`,
`sam.wire_refine`, and `wire.geometry`. An optional refinement timeout appears in
the successful response timeline and affected proposals, rather than failing the
whole request. The overall analysis deadline and client cancellation still abort
the entire request.
Timings are monotonic wall-clock durations and include transfer time, not GPU-only
inference time. The UI exposes these diagnostics directly on a failed run.

Previous generic 504 responses cannot be retrospectively attributed to a model
without historical timing logs. Reproduce the request with these diagnostics to
identify its actual source; no live provider result is implied by fixture tests.

## Development and validation

```sh
npm run check
```

This runs strict TypeScript checking, tests, a compiled build, and formatting checks.
Tests use Fastify injection and explicitly injected provider fixtures; they make
no paid network calls. They cover upload boundaries, EXIF rotation, native SAM
parsing, grounding conversion, schema rejection, authentication, rate/concurrency
limits, sanitized failures, retries, and cancellation. Synthetic native mask
fixtures cover contours, ambiguous shapes, duplicate masks, anchor checks, bounded
refinement, and unresolved-region behavior. Generated test images
exercise transport and decoding; they do not establish detection accuracy.

Live detection quality and your account's exact API compatibility require a real
Meta key and real evaluation photographs. They are not established by fixture tests.

## Layout

```text
praxis-backend/
├── server/
│   ├── src/
│   │   ├── routes/vision.ts       # Upload endpoint and admission control
│   │   ├── services/
│   │   │   ├── image.ts           # Image decoding and normalization
│   │   │   ├── sam.ts             # SAM requests and token adapter
│   │   │   ├── reasoning.ts       # Muse structured interpretation
│   │   │   ├── wire-geometry.ts  # Bounded decoding and mask plausibility
│   │   │   ├── wire-refinement.ts # Optional spatial SAM recovery
│   │   │   └── vision.ts          # Pipeline orchestration
│   │   ├── schemas/vision.ts      # Shared contracts and validation
│   │   ├── lib/                  # Safe errors and bounded Meta HTTP client
│   │   ├── app.ts                # Testable application factory
│   │   ├── config.ts             # Validated environment configuration
│   │   └── index.ts              # Startup and shutdown
│   ├── test/
│   ├── .env.example
│   └── package.json
└── README.md
```

## On-demand wire endpoint proposals

### Wire coverage, recovery, and identity review

New combined jobs run a local coverage audit after the original immutable SAM
checkpoint and before initial Muse interpretation. Existing jobs remain unchanged
until an explicit action. The saved photograph and original masks remain the
coordinate reference throughout; no snap policy or electrical connection is changed.

The audit diagnoses rejected masks (including disconnected components, broad masks,
branching, endpoint count, decode limits, and duplicates). It also proposes HSV color
components and local dark/light ridges, filters broad blobs, and skeletonizes bounded
regions. These are classical pixel operations implemented with Sharp and TypeScript;
no Python/OpenCV runtime is required. They are experimental hypotheses, can include
printed rails, text, component edges, and fragmented wires, and can miss low-contrast
wires. The 64-trace cap and other truncation limits are reported. An empty uncovered
list never establishes complete physical wire coverage.

`candidateCoverage` measures sampled trace overlap with masks that passed the existing
geometry policy. Rejected masks cannot hide unexplained traces. `verifiedCoverage`
uses current human identity decisions only. Revoking or superseding a decision removes
that verification; re-audit to refresh coverage. Possible fragment continuations are
recorded as hypotheses, never drawn as observed bridges or used to infer connectivity.

Authenticated job actions under `/api/analyses/:id/`:

| POST action          | Effect                                                                                                                                                                  |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `audit-wires`        | Local audit of the saved checkpoint; no model requests.                                                                                                                 |
| `recover-wires`      | Ranked incomplete regions select overlapping original-resolution 3×3 tiles, not the whole tile grid. At most two SAM calls per round by default.                        |
| `verify-wire`        | JSON `{ "candidateId": "jumper_wire_1" }`; one focused Muse identity/endpoint proposal using an unobscured crop, aligned observed-mask overlay, and full-scene context. |
| `wire-identities`    | JSON `{ reportId, candidateIds, state, note }`; human `verified`, `rejected`, or `uncertain` group decision. No hole assignment or connection.                          |
| `interpret-recovery` | Explicit Muse interpretation of a derived checkpoint; keeps historical original predictions and never runs SAM.                                                         |

Crop boxes and returned native mask boxes are translated back to original pixels;
mask rasters retain native crop resolution. Deduplication requires bidirectional
exact-pixel overlap, never bounding-box overlap, shared crossings, or matching color.
Ambiguous duplicate hypotheses may remain for review. Every changed crop result is
saved as a new immutable snapshot with a parent reference; the original SAM reference
and original Muse result remain intact. Interpretation uses the derived snapshot
only after the explicit action. A Muse-only retry stays bound to that attempt's input.

The default cumulative budget is four crop requests, two rounds, six million crop
pixels, two million pixels per crop, and eight focused verification requests per
analysis. Each dispatched crop/verification consumes budget durably before calling
the provider. Failed and timed-out crops are not silently retried or refunded, visited
tiles are not resent, and earlier successful crops survive failure. `cropAttempts`
records per-region `running`, `succeeded`, `failed`, `timed_out`, or `interrupted`
outcomes with source snapshot, timestamps, and upstream outcome. Success requires a
validated response and durable checkpoint (or a valid empty response). Lease loss and
shutdown terminalize running crop records without allowing stale completions to write.
Legacy `visited` records become stable `legacy_unknown` entries; they never imply a
successful inspection or refund a request. `visited` remains a compatibility field
meaning attempted, not successfully inspected. When only previously attempted,
uninspected regions remain, recovery reports `blocked_regions` rather than
`no_actionable_regions`. The UI shows these outcomes after reload. A local timeout
does not prove upstream execution stopped. Lease fencing protects budgets, reports,
and checkpoint writes from stale workers. Global experiment reservations block these
actions and include recovery workers in workload isolation. Provider diagnostics use
`sam.wire_crop` and `muse.wire_verify`; request bytes, dimensions, deadline, and timings
remain in attempt diagnostics and evidence exports.

Physical identity decisions remain bound to their original report. Empty or duplicate-only
crops retain same-report context. Changed checkpoints reconcile whole reviewed groups
using exact image/native-mask or trace fingerprints, independent of candidate numbering.
Only unique unchanged groups with no newly overlapping evidence carry verification;
missing, changed, ambiguous, or conflicting evidence produces `needs_review` and contributes
no verified coverage. Reconciliation links retain the original human review ID/report;
no new human decision is fabricated. Pending re-review survives later crops. Explicit
current decisions supersede carried context, including revocation to uncertain. All recovery candidates retain `identityStatus=unverified`
and `guidanceEligible=false`; separate human review records can verify an identity.
Muse cannot write a human identity decision, and every identity record retains
`electricalConnectionStatus=unestablished`. Two endpoint proposals do not establish
contact, polarity, continuity, or an electrical connection.

### Offline coverage and acceptance benchmarks

Export evidence first so the experiment survives job retention. From `server/`:

```sh
npm run evidence:export -- ANALYSIS_ID benchmark-evidence/my-run
npm run wire:audit -- \
  benchmark-evidence/my-run/snapshots/1.json \
  benchmark-evidence/my-wire-audit
```

`wire:audit` verifies the frozen snapshot hash, invokes no models, writes no database
state, and refuses to overwrite an existing directory. It writes `report.json`,
`overlay.png` (amber native masks, pink uncovered traces, blue covered traces), an empty
`truth-template.json`, and an `evaluation-template.json` listing all candidate IDs.
Counts are not measured recall. Truth templates deliberately start with
`recordedBeforeInference=false` and `completeInventory=false`; do not mislabel a
post-hoc inventory as a blinded baseline. Capture a complete independent inventory
before inspecting model output on held-out photographs.

Ground truth uses `version="wire-truth-v1"`, image hash, the two true capture flags,
and `wires: [{ id, endpoints: [{ visibility, holeId, position }, ...] }]`. Exactly two
endpoints are required; visibility is `visible`, `occluded`, or `off_image`. Visible
holes require original-image centers and board-qualified hole IDs (e.g. `board1:h10`).
Hidden endpoints remain recorded and cannot be treated as supported acceptances.

In the evaluation template, assign every candidate exactly once to a reviewed group
of up to eight IDs. Set `truthWireId` to a true physical identity or null for clutter,
record `matchKind` (`whole_wire`, `fragment`, or `clutter`) and `identityAccepted`, and copy the unchanged resolver's original predicted
`holeId`, original-image `position`, and explicit `accepted` decision for both ends.
Align endpoint order to independent truth once. Grouping fragments is a manual
benchmark annotation, not automatic visual/electrical continuity. Keep separate files
for baseline and improved experiments; never replace original predictions with corrections.

```sh
npm run wire:score -- \
  benchmark-evidence/my-wire-audit/report.json \
  independently-recorded-truth.json \
  reviewed-evaluation.json \
  benchmark-evidence/my-score.json
```

The JSON and terminal summaries include physical-wire recall, accepted-identity
precision, exact-hole accuracy, wrong/unresolved proposals, complete-wire accuracy,
wrong and unsupported accepted holes, duplicate groups, and pixel error/sample counts.
Fragments alone do not count as detected physical wires. Duplicate groups cannot inflate recall and competing identities cannot be cherry-picked
for endpoint accuracy. Missing endpoints stay in the visible-endpoint denominator;
hidden/off-image endpoints stay recorded but are excluded from that denominator.
Wrong or unsupported acceptances fail the gate. In `wire-score-v2`, identity correctness
uses the same unambiguous-group rule as endpoint correctness: a physical truth wire
requires exactly one whole-wire group, explicitly accepted. Competing groups receive
zero correct accepted identities, while every accepted group stays in the precision
denominator. Re-score frozen baseline and improved predictions with v2; do not compare
v1 and v2 precision as if their definitions were identical. The scorer never performs snapping.
The targets (≥95% recall, >98% identity precision, ≥95% exact-hole accuracy, zero wrong
accepted holes) are engineering gates, not demonstrated performance or guarantees.
Report per-image and held-out results, repeatability, latency, and wrong accepted
connections; this initial implementation is not evidence of reliable automated coverage.

### Optional focused endpoint input

Endpoint context additionally accepts `view="candidate_crop"` and optional
`gridPoints: [[x,y], ...]` (at most 1,000 original-image calibrated centers).
The original image is retained. Muse receives aligned photo/mask crops bounded to
1,600px, a full-scene context image, and a separate artificial grid reference when
provided. The grid is never physical insertion evidence. Crop-frame insertion and
junction pixels are checked before transformation back to original coordinates;
the response preserves `inputVariant`, `inputFrame`, and `sourceFramePosition`.
Hidden insertions remain null. Default full-image grounding remains unchanged.
This variant is opt-in and requires controlled accuracy/latency comparison before
general adoption.

`POST /api/vision/endpoints` accepts multipart `image` plus one JSON text field
`context`: `{ analysisId, imageId, image: { width, height }, wire: { id, bbox, mask }, otherWires?: [{ id, bbox, mask }] }`.
The wire must be a selected SAM-segmented candidate; `bbox` is original-image
`[x,y,width,height]` and `mask` is the existing bounded SVG path contract. No image
or analysis is retained on the server, so the caller supplies this context each
time. IDs correlate the reply; they do not authenticate an analysis stored here.
The photograph is decoded/rotated with the existing image preparation service, and
context dimensions and bounds are checked before inference. All wire IDs must be
distinct, with at most 99 neighboring masks and a combined 120,000-character path
budget. Metadata is bounded independently of the photograph upload.

`wire-grounding.ts` uses Sharp to render a deterministic image reference: the selected
SAM mask retains bright original pixels with a cyan highlight, neighboring masks
are darkened, and the background is dimmed/desaturated. Selected pixels win at
overlaps. This annotation preserves the original resolution and coordinates; no
scene content is generated or hidden pin location inferred. The service sends the
original photograph **and** aligned reference to Muse in one request. Its prompt
identifies the selected wire and image dimensions without serializing the mask
path as text. No annotated image is stored on disk or returned to the browser.

One structured Muse call returns ordered endpoints A/B with
`proposedImagePosition: [x,y] | null` for the actual physical insertion point,
plus `connectorJunctionPosition: [x,y] | null` for a separately visible
wire-to-connector junction. Evidence is `visible_insertion`,
`visible_connector_junction`, `occluded_insertion`, or `insufficient`.
Only visible insertion evidence permits an insertion position; all other evidence
requires a null insertion. A junction is not the pin or hole beneath a connector
body, and neither a mask tip nor a nearby calibrated hole is a valid substitute.
Invalid roles, inconsistent evidence/positions, missing visible-junction coordinates,
out-of-image positions and invented hole fields fail closed. The response echoes
the analysis/image/wire IDs and configured model, with `image.prepare`,
`wire.grounding`, and `muse.endpoints` timing. Endpoint requests override automatic
provider retries to zero; their one attempt still uses the configured provider
timeout. Initial Muse interpretation also uses one attempt; SAM retries remain configurable. Two images may increase provider
latency; local rendering tests do not establish an inference speed improvement.
The frontend, using user-confirmed calibration and registered rails, resolves
pixels to holes and obtains independent user review. This API does not confirm
wire identity, electrical contact or continuity, and never returns hole IDs.

The route shares authentication, browser-origin rejection, rate limiting,
concurrency admission, upload bounds, deadline/cancellation and sanitized errors
with analysis. The Next proxy exposes the same endpoint without revealing server
credentials. No new environment variables are required. Fixture tests cover the
provider contract, invalid output/context, HTTP transport and shared capacity;
they make no external model calls.

### Targeted short-wire recovery and crop fragments

`POST /api/analyses/:id/recover-short-wires` runs a separate experiment using the
existing cumulative request/pixel/round budgets. Optional JSON is
`{ pitchPx, gridPoints, manualPoint?: [x,y] }`, all in original-image pixels.
`gridPoints` has at most 1,000 calibrated centers; they guide the search and never
prove wire identity or insertion. The UI can share current calibration as a search
prior; share it again after recalibration. Without a calibration, bounded native
image regions use component neighborhoods, uncovered short traces, board regions,
and existing crop exits. At most twelve local crops of at most 512×512 pixels are
scanned locally; only evidence-bearing regions produce SAM requests, still capped
by the existing model budget. Short-mode color/dark-line filtering operates at
native crop resolution and does not change the general detector's acceptance policy.

Automatic regions generate box/positive/negative-point prompts, rather than another
generic `wire` request. A clicked wire-body seed uses the same path but is recorded
as `mode=human`, separately from `mode=short` automatic requests. Do not count
user-assisted results as autonomous recall. Original snapshots and all crop-attempt
outcomes remain preserved. No mask is a confirmed wire or electrical connection. If an older
job has exhausted its recovery budget, usage is not reset. For a separately planned
cached-SAM experiment, increase cumulative limits explicitly (for example,
`WIRE_RECOVERY_MAX_REQUESTS=8`, `WIRE_RECOVERY_MAX_ROUNDS=4`, and
`WIRE_RECOVERY_MAX_PIXELS=8000000`) and restart the backend. The old requests remain
charged; no whole-scene reanalysis is required. Keep those larger limits local to the
experiment and within the validated configuration bounds.

SAM crop candidates expose `cropOrigin`, `touchesCropBoundary`, and observed
`cropExitPoints`. Crop-edge contact is distinct from photograph-edge contact.
Truncated masks remain reviewable fragments and cannot supply insertion proposals.
Neighboring recovery searches can use crop exits. Fragment associations combine
spatial overlap/proximity, sampled color similarity and approximate direction;
they remain unverified hypotheses with their signals recorded. Masks are never
joined through unobserved gaps or promoted into connections. Diagnose each missing
physical wire against raw candidates, rejection reasons, budget outcomes, and main
view selection before assuming it was never segmented.

### Bounded insertion close-ups and coordinate contracts

`POST /api/vision/endpoints` additionally accepts `view=endpoint_crops`. It first
runs the existing focused wire request, then uses its visible insertion/junction
references as approximate search anchors. At most **one additional Muse request**
contains both endpoint regions, untouched photographs, separate mask/grid references,
and full-scene identity context. Regions are bounded and sized using available hole
spacing. An endpoint without an observed anchor remains unknown; a crop boundary,
artificial grid, connector body or mask tip is not insertion evidence. No loop retries
until a point snaps. Failed close-ups retain coarse proposals in `localization` while
primary insertion results become unknown; parent cancellation still aborts the request.

The response preserves coarse endpoints, crop rectangles, raw source coordinates,
converted original-image positions, status and diagnostics. `coordinateSpace` may be
`pixels` (default) or experimental `normalized_1000`; the latter explicitly requests
coordinates in [0,1000), converts them with the actual input frame dimensions, and
stores the original coordinates. For two-stage responses, `inputFrame` describes
the coarse request and `localization.frames` gives each refined endpoint frame. This tests a coordinate contract independently from
crop changes. The deterministic frontend snap policy is unchanged.

`MUSE_CONCURRENCY=2` caps locally active Muse requests across interpretation,
verification, and endpoints using shared SQLite admission leases. Admission waiting
appears as `muse.admission`; close-up execution as `muse.insertion_closeups`.
`JOB_WORKER_CONCURRENCY` remains independent and defaults to one. Expired/stale
admission owners cannot publish late responses. This bounds local activity, not
unknown upstream execution after a timeout. Team RPM/TPM and provider queuing may
still prevent a latency improvement.

### Controlled endpoint grounding comparison

From `server/`, after exporting a bundle with exactly one original proposal per wire:

```sh
npm run experiment:endpoints -- ANALYSIS_ID /actual/path/bundle.json \
  benchmark-evidence/grounding-full-focused \
  --variants full,candidate_crop --concurrency 1 --runs 1
```

This command **makes live model calls**; it is not an offline scorer. It verifies the
image/checkpoint binding, reserves global experiment admission, preserves all saved
analysis/predictions, and writes progress into a new private directory. Ground truth
is never read by the live runner. At most thirty provider requests are planned; a
close-up variant budgets two per wire. Every provider request has automatic retries
disabled. Frozen original proposals provide unverified role anchors solely to label
the same A/B ends, never as insertion evidence; ground truth is not used for these
anchors. For latency alone, run a separately named experiment with `--concurrency 2`.
Use `--variants endpoint_crops` to isolate two-stage localization, and
`--coordinates normalized_1000` to isolate coordinate representation. Keep the same
model, wires and calibration. A local timeout interrupts the experiment and retains
its reservation because upstream completion is unknown. Release explicitly using
`npm run experiment:muse -- --release EXPERIMENT_ID` after inspecting the outcome.

From `praxis-frontend/`, score without any model calls:

```sh
npm run benchmark:grounding -- /actual/path/bundle.json /actual/path/truth.json \
  /actual/path/grounding-full-focused/report.json /new/path/grounding-score.json
```

Truth uses the existing blinded endpoint truth format. Input hashes and calibration
must match, and original proposal/calibration revisions must be current. Original
abstentions and missing/failed calls remain in the denominator. A/B correspondence is
chosen from the frozen original once, not reselected to favor an experiment. Reports
include the frozen baseline, each fresh variant/run, wrong and unresolved holes,
complete wires, correct→wrong/unresolved regressions, paired coordinate errors,
reference basis, request count, and batch wall time including rendering/admission.
The five-wire interim gate is at least 8/10 correct endpoints, 4/5 complete wires,
zero wrong holes, zero regressions, and under 75 seconds. Wire coverage (15/17) and
identity precision are separate measurements, not inferred from endpoint success.
No improvement is established by synthetic tests; repeat on held-out photographs.

Endpoint close-up responses additionally preserve `localization.requestStatus` and
ordered A/B `endpointOutcomes`. Outcomes distinguish `localized` (a visible pixel
proposal, still subject to strict snapping), `abstained` (a completed model response),
`no_anchor` (no crop supplied), `crop_fragment` (blocked before any provider call),
`failed`, and `timed_out`. A single request can complete while one endpoint has no
crop. Failed refinement keeps its coarse endpoints independently available in the
response, with no automatic fallback into active insertion assignments.

New endpoint experiment reports use `endpoint-grounding-experiment-v2`. Each
measurement retains its legacy execution `status` and adds `outcomes` for handler
execution, localization, per-endpoint results, and observed transport request timings.
A handled `no_anchor` or `crop_fragment` response may have execution `succeeded`;
that does not count as completed endpoint localization or correct insertion. A
transport response can also complete yet fail output validation. The terminal runner
prints these distinctions and does not claim accuracy without blinded truth.

The offline scorer accepts historical v1 reports too and emits
`grounding-comparison-v2`: frozen baseline, same-run coarse predictions, final
operational yield over all truth endpoints, and conditional completed-localization
scores with explicit denominators. Failure, missing response, abstention, skipped
crop and strict snap rejection remain distinct. Coarse predictions from a failed
close-up are still scored; final operational results remain unresolved. Paired
coarse-to-final pixel errors report their sample count. No prediction is overwritten
and no snap policy, acceptance requirement, timeout or retry policy is relaxed.

### Preserve selectable wire evidence across interpretation

A successful Muse interpretation no longer replaces the selectable mask list for
its checkpoint lineage. The worker reconciles the fresh result with the last
published selection and earlier successful attempts from the same photograph and
ancestor SAM checkpoints. It does this locally, without another model request.

Exact mask geometry, original-image bounds, image hash, and crop-boundary metadata
identify unchanged evidence. Existing selectable IDs stay stable even when Muse
renumbers its result. Previously selectable masks omitted by the latest
interpretation remain inspectable, labeled retained and uncertain. Historical masks
already lost before this change can be restored under new IDs without reusing an
existing wire's identity. Changed interpretations and overlapping new hypotheses
are flagged for review; spatial overlap never merges them. A later model confirmation
does not silently clear that warning. Physical wire review remains a separate,
snapshot-bound record, and electrical connection status is unchanged.

Each published wire can include `selectionEvidence`: its geometry fingerprint,
source snapshot/attempt, latest raw object ID when present, retained/current state,
and review reasons. `provenance.wireSelection` summarizes matched, retained, added,
historically restored, and deferred masks. Those are candidate counts, not distinct
physical-wire recall. Raw model-filtered outputs stay unchanged in each attempt's
`result`, separate from the reconciled `muse.result`; private evidence export
preserves both. New SAM roots or a different photograph start a new selection.

The existing 100-object and 120,000-path-character limits remain enforced. Earlier
selectable masks take priority; new candidates that do not fit are listed under
`deferredObjectIds` and remain in the raw attempt evidence. If even the preserved
selection plus fresh non-wire objects cannot fit, publication fails with
`WIRE_SELECTION_BUDGET`, retaining the previous published result and the new raw
response. Timeout, interruption, and stale-worker ownership guards are unchanged.
No endpoint review, assignment, calibration, hole snap policy, crop-boundary gate,
or identity verification is automatically carried into a new analysis revision.

The regression fixture `test/fixtures/phase3-wire-selection.json` uses the supplied
Phase 3 before/after rendered states and read-only checkpoint metadata. It preserves
the qualification that these states were not a byte-verified browser export. Run:

```sh
node --import tsx --test test/wire-selection.test.ts
```

Offline replay retains 14 earlier mask hypotheses, matches seven of the ten latest
masks, and adds three, yielding 17 selectable hypotheses. It also verifies that the
white diagonal and lower-yellow masks survive and the new green/blue masks remain
crop-truncated. This is **not 17/17 physical-wire recall**: historical clutter and
partial traces remain candidates requiring visual review. Replaying an already
regressed state restores seven older masks while preserving the latest orange
wire's ID. No live inference or saved job was changed by these replay tests. The
new selection behavior takes effect on the next successful interpretation; it does
not rewrite previously exported benchmark results. Continuation recovery and
short-wire detection still need separate measured improvements.

### Recovered candidates without scene interpretation

Every saved recovery checkpoint now publishes a local `candidateResult` under the
same worker lease, before waiting for Muse. The public `result` prefers this view,
so new geometry-passing masks are selectable for calibration and endpoint review
even if every scene interpretation times out. For an existing saved job, **Audit wire
coverage** also refreshes the candidate view from its latest already-saved recovery
checkpoint, including when the crop budget is exhausted. Audit performs no provider
requests and does not consume the crop budget. Repeating an audit of an already
published checkpoint does not change its view revision. The source image frame is unchanged.
`sam.result`, immutable raw checkpoints, original interpretation attempt results,
and the last successful `muse.result` remain separate. A timeout preserves the
latest candidate view. Successful Muse interpretation reconciles against that view
instead of removing locally recovered masks.

`provenance.candidateLayer` records version, publication (`local_geometry` or
`muse_reconciled`), source snapshot/hash and source attempt. Each checkpoint changes
the analysis revision; earlier endpoint reviews become stale. Human identity
reviews remain independently snapshot-bound. A local observation preserves prior
color/category evidence for exact mask matches; it does not fabricate a new Muse
confirmation or disagreement. New masks stay uncertain and identity-unverified.
Truncated masks retain their insertion-point gate. Overlapping hypotheses remain
separate; counts do not establish physical-wire coverage or electrical connections.

The output budget still prioritizes earlier selectable evidence. If a combined
candidate view cannot fit, the raw recovery checkpoint remains saved, the earlier
view stays visible, and `candidatePublicationError=WIRE_SELECTION_BUDGET` explicitly
identifies the publication limit. Raw checkpoint retention does not depend on Muse.

### Focused interpretation experiments and diagnostics

The scene defaults are unchanged. Run one controlled variant on an inactive saved
job; no SAM rerun or original-prediction replacement occurs:

```sh
npm run experiment:muse -- ANALYSIS_ID --variants 1280-minimal \
  --snapshot SAM_SNAPSHOT_ID --output NEW_SCENE_REPORT.json

npm run experiment:muse -- ANALYSIS_ID --variants focused-candidates \
  --snapshot SAM_SNAPSHOT_ID --candidate-ids jumper_wire_31,jumper_wire_43 \
  --variant-budget-ms 45000 --output NEW_FOCUSED_REPORT.json
```

These are **live provider calls**, not offline replay. IDs are native candidates in
the selected immutable checkpoint, not display IDs assigned to the reconciled
selection. Omitting `--snapshot` now chooses the latest saved recovery checkpoint,
falling back to the original SAM checkpoint. Default variants remain
`original-current,1280-current,1280-minimal`; `--variants` selects/reorders distinct
variants. Focused verification is opt-in. Omit `--candidate-ids` to select up to
three geometry-passing candidates, prioritizing crop evidence, or explicitly select
up to four. An invalid selection is rejected before provider dispatch.

Each focused request receives an untouched crop and aligned mask reference, with
maximum dimension 1280. Its smaller response schema asks only for identity:
`one_visible_wire`, `multiple_wires`, `fragment_only`, `not_wire`, or `uncertain`.
It does not request endpoint coordinates, hole IDs, connections, or an exhaustive
scene inventory. Crop-truncated candidates are recorded as skipped with no provider
request. The identity decision remains a model proposal; it does not create a human
identity review, accepted endpoint or electrical connection.

Reports use schema version 3 and save each successful focused check independently,
including candidate ID, evidence fingerprint, snapshot, decision, diagnostics and
backend runtime fingerprint. The per-variant budget defaults to the smaller of the
provider and stage limits; `--variant-budget-ms` may lower it. It covers audit, preparation,
admission and **all** focused checks together. Phase wall time is saved separately
from each check. Comparing several variants can exceed one phase budget overall.

Any unknown upstream outcome stops remaining candidates and variants and preserves
the interrupted reservation. Inspect the partial report and explicitly release it
before further model work; release does not prove upstream execution stopped.
`--output` must be new. No automatic retries, parallel verification or timeout
increases were introduced.

Diagnostics distinguish `muse.prepare`, `muse.admission`, provider request/body time,
`muse.validate` (JSON/schema and semantic checks), and `wire.selection`. They retain
image dimensions/count, encoded bytes, total payload bytes, prompt characters,
output schema bytes, optional configured token budget, header latency, request ID
and timeout type. Missing header latency means no headers were recorded before the
deadline; it cannot distinguish network/upload delay, provider queueing and inference.
Request success and model counts are not quality scores: review the same frozen
candidates against independent physical-wire annotations and compare false wire
acceptances, abstentions, retained masks and total phase time, including failures.
Use the existing `wire:score` workflow for independently annotated physical-wire
coverage/identity and the frontend `benchmark:grounding` for exact-hole comparisons.

### Build and algorithm provenance

New analysis/candidate views and endpoint proposals carry `runtime` with a SHA-256
fingerprint of backend application code plus the dependency lockfile, its
source/compiled representation and pipeline algorithm versions. Public job reads
also return the **currently running** backend fingerprint separately from the
producer recorded by a saved result. Old saved results retain their original
provenance, including an explicit absence of runtime data when it was not recorded.

Frontend evaluation bundles record the frontend build fingerprint, current backend
fingerprint observed during polling, and the saved result producer. Per-endpoint
proposals record their own backend producer. The frontend fingerprint hashes app,
components, library code, configuration and lockfile at production build or dev-session
startup. Development HMR can change code within a session: restart both development
servers after code edits before a controlled benchmark. Production fingerprints bind
the built client source snapshot and running backend artifacts. No environment
values, credentials, source files, or photograph bytes are included in fingerprints.
Inspect **Benchmark build provenance** beside the evaluation export control.

### Experiment budgets and comparison completeness

`variantBudgetMs` and `--variant-budget-ms` are the canonical names. The deadline
restarts for **each variant**; all focused checks within that variant share it.
There is no total-experiment deadline. `experimentElapsedMs` measures monotonic
runner elapsed time from entry through the report snapshot, including checkpoint
loading, admission and work across variants; it excludes CLI startup. Multiple
variants may consume several budgets. `variantTimings` contains per-variant durations.

For compatibility, the old programmatic `phaseBudgetMs` and CLI `--budget-ms` remain
accepted aliases. The CLI prints a deprecation notice. Supplying conflicting alias
and canonical values is rejected before reservation or provider dispatch. New v3
reports emit the canonical fields; existing v1/v2 reports are not rewritten.

Reports explicitly record `plannedVariants`, `attemptedVariants`,
`unattemptedVariants`, `variantRuns`, `unattemptedCandidates`, and
`comparisonComplete`. A variant is attempted when its operation starts; that does
not guarantee an HTTP request was sent. Focused records additionally show planned
and attempted native candidate IDs. An automatic candidate plan is materialized
only when its audit runs; an unattempted automatic variant has no known candidate
list. Measurements retain `upstreamOutcome`, including `not_sent` for local skips.

`comparisonComplete` means the requested plan was executed to terminal observations,
including all planned focused checks, and the runner completed normally. It does
not mean requests succeeded, identities were correct, or latency targets were met.
Interrupted reports always set it false. Unattempted variants/checks are neither
model abstentions nor failures. A failed provider request can be a valid terminal
observation, while a focused batch that stopped early remains an incomplete
comparison even if the runner processed its other variants and completed.

Read a saved report offline without provider credentials, modifying the file or
starting any model requests:

```sh
npm run experiment:muse -- --summarize /actual/path/report.json
```

The summary supports v1/v2/v3, retains available image/snapshot/model/runtime
provenance, maps the legacy budget/timing names, and infers legacy completeness
conservatively. Missing historical total elapsed time stays `null`; per-variant
durations are not added and mislabeled as a measured experiment total.

If the first variant times out, collect other configurations with separate explicit
experiments after inspecting and releasing the interrupted reservation:

```sh
npm run experiment:muse -- ANALYSIS_ID --variants 1280-current \
  --snapshot SAM_SNAPSHOT_ID --variant-budget-ms 45000 --output NEW_REDUCED_REPORT.json
```

Keep image, checkpoint, model settings and deadline fixed where applicable. A
single-variant report describes only that configuration; it does not declare an
entire multi-configuration study complete. A timed-out configuration remains an
observed failure in the evidence. Separate local experiments and explicit release
still do not prove earlier upstream work stopped. Retain this isolation uncertainty
when comparing latency, and do not rerun until a favorable result appears.

### Physical-wire metrics and reviewer evidence

`wire:score` now emits `wire-score-v3`; the v1 truth/evaluation inputs remain valid.
New metrics separate raw SAM candidate count, audited candidate count, geometry-
passing mask candidates, explicitly selectable masks, selectable physical-wire
coverage, fragment groups, crop-truncated masks, duplicate groups, complete
segmentation coverage, and confirmed physical-wire coverage. The complete inventory
remains the denominator: use all 17 physical wire IDs for the current experiment.

Optionally add `selectableCandidateIds` to the evaluation JSON. These must be unique
native IDs from the frozen recovery report, independently mapped from the actual
selectable view; reconciled display IDs can differ. Missing mapping yields `null`,
not a guessed count from geometry passes. An explicit empty list means zero.
Selectable physical coverage counts each annotated physical wire once, including
selected partial traces; duplicate masks cannot increase it. Complete segmentation
requires an unambiguous whole-wire group with usable, geometry-passing masks and no
crop truncation, separately from the existing endpoint-pair `completeWires` metric.

Both truth and evaluation JSON can optionally record the actual annotation source:

```json
"reviewProvenance": {
  "source": "human_visual",
  "reviewer": "independent reviewer identifier",
  "recordedAt": "2026-10-30T12:00:00Z"
}
```

Allowed sources are `human_visual`, `assistant_visual`, `physical_inspection`, and
`continuity_test`. Use the actual reviewer and timestamp; do not label an assistant
visual audit as human review. Confirmed coverage is emitted only when both the
inventory and candidate associations explicitly record human review or physical
inspection. Otherwise `confirmedPhysicalWires` and `confirmedPhysicalWireCoverage`
stay `null`. Counts require unambiguous accepted whole-wire identities against that
inventory; competing groups cannot be cherry-picked, even if only one is accepted.
`correctAcceptedIdentityCoverage` remains the annotation-relative metric available
for legacy/assistant-only files, with the same fixed denominator.

These are independently supplied benchmark annotations, not proof generated by SAM
or Muse. Scoring never changes the native identity-review ledger or establishes
electrical contact. Existing `targetsMet` remains the annotation-relative benchmark
gate, not a physical-verification or deployment certificate. Earlier score artifacts
are unchanged; no higher physical-wire coverage is claimed without an annotated
retest on real photographs.

### Native-resolution continuation and short-wire recovery

`recover-wires` now schedules wire-centered crop continuations and local short-wire
spatial prompts before broad tiles, alternating the two targeted queues so one class
cannot consume every early request slot. Existing cumulative limits remain unchanged.
A source mask is never extended by drawing synthetic pixels. SAM observes a larger crop
with positive anchors taken from the original mask, then every returned object is checked
against its own prompt. Up to three objects in one crop share a request, charged once for
that request and its crop area. The ledger persists ordered `spatialPrompts`, per-target
`workKeys`, and continuation `sourceCandidateIds`. Keys bind the crop and prompt rather
than a mutable checkpoint ID. Identical failed/timed-out work is not silently retried;
different seeds in the same crop are separate work. Legacy unknown crop records remain
blocked because their original prompts cannot be reconstructed.

Duplicate filtering permits a reviewable extension only when a geometrically valid mask
contains at least 95% of the original fragment's native pixels, grows by at least 15%, and
has at least six pixels / 5% of its observed area beyond the original crop. These checks
are deliberately conservative, not wire identity verification. Both raw masks remain in
immutable snapshots, and the new selectable hypothesis cannot overwrite an old stable ID.
Continuation anchors use raw checkpoint masks even when an audit preview was omitted
by the path budget. New seed-validated masks receive decode/preview priority within the
existing quotas; checkpoint order and earlier selectable evidence are preserved.
The audit records `mask_extension_proposal` with `status: unverified`; overlapping evidence
invalidates automatic review carry-forward. Complete observed extensions stop further
requests for the old fragment. Truncated extensions can anchor another bounded recovery
round. A crossing, a nearby parallel wire or box overlap alone cannot justify an upgrade.

Short-wire scans decode the source once, inspect at most 64 native windows / 12 million
crop pixels across the board, and retain at most 16 unattempted targets. Actual native
mask pixels determine whether a trace is already covered; a long wire's bounding box
cannot hide a separate short jumper. This is a candidate generator, including potential
clutter, not a measured physical-wire detector.

For a larger **explicitly budgeted** continuation/short-wire experiment, an example is:

```dotenv
WIRE_RECOVERY_MAX_REQUESTS=12
WIRE_RECOVERY_REQUESTS_PER_ROUND=3
WIRE_RECOVERY_MAX_ROUNDS=4
WIRE_RECOVERY_MAX_PIXELS=16000000
WIRE_RECOVERY_MAX_CROP_PIXELS=2000000
```

Restart the backend after configuring limits. This permits more paid requests; it does
not reset previously charged requests, clear unknown upstream outcomes or imply that all
requests must be used. Default limits remain four total requests / two per round / two
rounds / six million crop pixels. Record configured limits in benchmark evidence.

Run the existing focused endpoint experiment only after selecting complete observed
masks. Keep scene interpretation outside the wire-coverage critical path, compare fixed
wires/calibration, retain missing/blocked endpoints in the full denominator, and keep
zero accepted wrong holes as a hard gate. Recovered mask count, independent physical-wire
coverage, identity precision and electrical connectivity remain separate measures.

### Recovery quarantine, uncertain topology, and explicit retries

Prompt-mismatched masks remain in immutable raw checkpoints with
`recoveryPromptMatched: false`. They are excluded before interpretation, local
publication and coverage auditing. They cannot consume eligible candidate slots,
suppress a later valid observation as a duplicate, seed recovery, or inherit verified
coverage. The report lists their IDs and reasons under `quarantinedCandidates`; it
retains the full raw SAM count separately. Valid observations beyond the eligible
100-candidate limit are also retained but quarantined as `candidate_capacity`.

Raw retention has its own guard: dispatch stops once a checkpoint has at least 200 raw
observations or 8 MiB of encoded mask payload, reserving room for the next bounded
100-mask response. This avoids silently truncating a provider response. A
`raw_evidence_budget` stop means preserved raw evidence needs inspection, not that
physical wire coverage is complete. Old snapshots are unchanged. The audit identity
now includes policy v2 so prior review context is explicitly reconciled rather than
silently reused across the eligibility change.

Continuation planning has topology-supported and topology-uncertain queues. The
uncertain queue can observe a disconnected or branched crop fragment without relaxing
returned-mask acceptance. Its positive anchor must lie on one observed boundary-touching
connected component. Equally plausible boundary components, missing anchors and pixel
limits produce explicit planning diagnostics. `WIRE_CONTINUATION_UNCERTAIN_MAX_REQUESTS`
defaults to one normal request per analysis (zero disables it; maximum three), charged
inside the existing cumulative SAM request, pixel and round budgets. A later recovery
round reserves its first available slot for this queue so it cannot be indefinitely
starved by supported continuations. Failed requests consume the allowance. Explicit
operator retries remain separately authorized and still consume the total budgets.

`POST /api/analyses/:id/retry-wire-crop` accepts:

```json
{
  "attemptId": "ORIGINAL_CROP_ATTEMPT_UUID",
  "authorization": "accept_unknown_upstream",
  "reason": "Operator inspected the saved timeout and authorizes another attempt"
}
```

Use `known_outcome` only when the recorded upstream outcome is `not_sent` or
`response_received`. A timeout or interrupted attempt with unknown upstream status
requires the explicit `accept_unknown_upstream` acknowledgment; this does **not** mark
the earlier provider request finished or cancelled. The server rebuilds the exact
original crop and prompts, records a new attempt with `retryOf`, authorization, reason
and timestamp, preserves the old work keys/outcome, and charges another request, pixels
and round. Only one explicit retry per work item is allowed. Successful crops, retry
chains, exhausted budgets, concurrent work, stale photographs and legacy records without
a reproducible request cannot be retried. Worker leases still fence late results.
No retry occurs just because time has passed.

`POST /api/analyses/:id/verify-wire-extension` accepts the current `reportId`,
`sourceCandidateId`, and extended `candidateId` from a `mask_extension_proposal`.
It compares an untouched focused photograph, original-fragment overlay,
proposed-extension overlay and untouched full-scene context. The concise model result
records continuity, adjacent-wire, crossing and component-lead evidence. A
`same_physical_wire` response is rejected if any relevant observation remains ambiguous
or continuity is occluded. Crop-truncated extensions stay blocked. Results are bound
to the report/checkpoint under `extensionReviews` and consume the existing Muse
verification budget. They never create human reviews, assign holes or establish
connections; new checkpoints require a fresh extension check.

### Connector-only SAM diagnosis

Guided scene requests now retain private diagnostic evidence in `scene_requests`,
linked by request ID. This includes crop JPEG bytes/SHA-256, exact request JSON,
bounded raw HTTP response bytes/status, decoded native candidates, preview failures
and provider/decoder/quota failure phases. Request authentication headers are never
captured. Browser job JSON does not expose these private payloads. `evidence:export`
includes them under `scene-requests/`; deletion/retention cleanup removes database
records with their source analysis. Old runs cannot retroactively acquire raw bodies.

Prepare the three-arm connector experiment offline, using the exact inventory UUID
and visually inspected original-image targeting points:

```sh
npm run experiment:connector -- prepare ANALYSIS_ID OBJECT_ID POS_X,POS_Y NEG_X,NEG_Y NEW_DIRECTORY
```

Review `plan.json` and the crop JPEGs before dispatch. Arm A uses `battery connector`
on the original crop; B uses the same noun on a wider native crop; C uses only the
native box/point grammar on the same JPEG bytes as B. Points target the physical
object, not electrical contacts or polarity. The prepared hash binds source photo,
scene/SAM checkpoints, object ID, model, destination, images and prompts.

```sh
npm run experiment:connector -- run PREPARED_DIRECTORY/plan.json NEW_RUN_DIRECTORY
```

Run sends up to three SAM requests to the configured external Meta service and zero
Muse requests, with no retries and a separate six-million-pixel experiment ledger.
A shared reservation fences ordinary jobs; source scene work must also be inactive.
Production budgets, results, object IDs and observations remain unchanged. Unknown
execution stops remaining arms and retains an interrupted reservation for explicit
release using the existing experiment release command. Durable evidence survives a
CLI interruption and is available through the offline exporter. Output paths are new.
Candidate masks remain proposals until independently inspected.

Identity matching can be replayed without inference or production writes:

```sh
npm run scene:replay-identities -- BEFORE_BUNDLE.json REFRESH_BUNDLE.json NEW_REPORT.json
```

The replay reports candidate matches and ambiguities using category/part compatibility,
semantic aliases, geometry, board anchors and direct segmentation references. Wire
reuse still requires matching descriptions and strong geometry; shared boxes or mask
references alone do not establish physical-wire identity. Replay suggestions are not
independent truth and do not merge existing duplicate objects in a saved scene.

### Connector body versus attached lead

`experiment:connector prepare-boundary ANALYSIS_ID OBJECT_ID PROFILE.json NEW_DIRECTORY`
creates an offline three-arm plan. The strict profile defines the visible connector
body separately from an experimental connector-plus-red-lead composite, source image
hash, manual targeting boxes/points and sparse held-out pixel probes. The profile
and probes are included in the immutable plan hash. A/B differ only by a second
positive body point; C deliberately changes the target scope and red-lead point label.
All three use the same native context JPEG bytes. No noun phrase is mixed with native
geometry. The installed official parser builds the spatial prompts.

`evaluateBoundaryMask` decodes native binary masks and reports foreground area and
probe inclusion by body, red lead, black lead, battery and background. It refuses
mask/observation identity mismatches and non-unit raster mappings. Prompt/evaluation
point reuse and points outside the frozen crop are rejected before dispatch. Sparse
probe agreement is not full boundary accuracy, independent physical truth or automatic
acceptance. Composite targets are experimental scopes, not production identity merges.
The existing separate reservation, three-request cap, six-million-pixel ceiling, zero
Muse requests, raw capture and no-retry safeguards also apply to boundary plans.

### Durable connector outcomes, ambiguity review and automatic targeting

Connector reports use `completed` only when every planned arm finished, including valid empty outputs. Definitive pre-dispatch, HTTP, decoding and local processing errors are `failed`. Cancellation or uncertain dispatch is `interrupted`. Final status, final measurement and completion time are persisted together before returning; terminal ownership is released once. Interrupted reservations retain charged work and require explicit release. The CLI exports failed/interrupted request evidence and exits unsuccessfully. A lost process can leave an unfinished running report; lease recovery blocks replay rather than assuming its request did not execute.

Inventory refresh retains duplicate-looking proposals in persistent `ambiguityClusters`, with stable object/observation references and comparison evidence. Subsequent refreshes extend an existing cluster when candidate identities overlap. Bridging clusters keep their IDs and cross references. `ambiguityReviews` record human decisions against the exact checkpoint and complete current membership; added members require another review. These records do not merge objects, terminals or conductor identities. The workspace exposes members and comparison evidence, and evaluation bundles include clusters and review history. Existing reciprocal matching and conductor safeguards remain unchanged. Evidence budgets still fail closed; clustering does not make repeated inventory refresh free or remove retained hypotheses.

The manual connector runner remains a reference benchmark. A separate **experimental automatic targeting stage** consumes persisted inventory and original broad SAM evidence, never manual boundary profiles, manual points or guided masks:

```sh
npm run experiment:connector -- prepare-auto ANALYSIS_ID CONNECTOR_OBJECT_ID NEW_DIRECTORY
```

Preparation is offline and changes no production graph or request budget. The stage always proposes an approximate inventory-box arm. It adds one interior-point arm only when a linked baseline mask supplies foreground at least two pixels from its boundary, inside the target box and outside neighboring non-board boxes. Otherwise it explicitly abstains from points. Cues and observation IDs are frozen in the plan and recomputed before execution. Neither arm establishes a physical boundary. This initial generator does not synthesize negative points from approximate neighboring boxes.

The existing `run PLAN.json NEW_DIRECTORY` command executes only the arms in the prepared plan, at most three requests and six million pixels, zero Muse and no retries. Sending saved photographs still requires a new, specific inference approval. After a permitted run, evaluate it offline against a profile frozen before execution:

```sh
npm run scene:score-targeting -- REPORT.json FROZEN_PROFILE.json NEW_OUTPUT.json
```

The scorer binds plan, photograph, object and native masks, retains empty/failed outcomes, and reports the same sparse probes and pixel extent measurements as the manual benchmark. Frozen assistant profiles are comparison baselines, not independent ground truth. Independent masks and additional photographs remain necessary before claiming autonomous targeting accuracy.

### Shared automatic connector workflow

The workspace and automatic CLI use `ConnectorWorkflowService` for preparation, execution, evaluation and export. Neither interface calculates cues, budgets or mask quality. The manual reference runner remains separate. Preparing a workflow sends no inference and does not change production scene settings, identities, observations, terminals or connectivity.

Each immutable contract contains the runner plan, canonical SHA-256 hash, exact A/B request specifications, provider/model identifier, original-image dimensions, crop pixel coordinate system, JPEG hashes, snapshot/object evidence, timeout and budget policy, and the frozen evaluation protocol. Hosted provider version resolution remains explicitly unknown when unavailable. B has no request specification when baseline foreground cannot support an interior point; the A/B comparison remains incomplete. Manual references and identity reviews never enter cue generation.

The workspace exposes **Prepare automatic connector test**, an exact provider/request/pixel authorization, **Run prepared connector test**, candidate mask overlays, physical identity review, local evaluation and a private evidence download. The browser evaluation bundle includes `sceneEvaluation.automaticTargeting`, preserving plans, effective isolated budgets, cues, abstentions, accounting, outcomes, latency, previews, frozen thresholds and evaluation provenance. Public previews have a shared size budget; the private JSON download and offline archive retain raw crop bytes, requests, provider responses and every native mask. These experiments do not consume or silently enable the production guided budget.

```sh
# Offline preparation; an independently reviewed pixel reference is optional.
npm run experiment:connector -- prepare-auto ANALYSIS_ID OBJECT_ID NEW_DIRECTORY [FROZEN_REFERENCE.json]
# After destination-specific approval, execute the registered plan exactly once.
npm run experiment:connector -- run NEW_DIRECTORY/plan.json NEW_RESULT_DIRECTORY
# Offline human mask identity reviews and evidence export.
npm run experiment:automatic -- evaluate WORKFLOW_ID NEW_EVALUATION.json IDENTITY_REVIEWS.json
npm run experiment:automatic -- export WORKFLOW_ID NEW_EVIDENCE.json
```

A workflow is permanently spent once admitted. Dispatch intent and its reservation are committed before transport; raw response bytes and response-recorded state are committed together before parsing. Failed transactions roll back both database and in-memory evidence fields. Execution state, provider outcome and evaluation status remain separate. Evaluation errors preserve successful execution and earlier evaluations. Concurrent writes use revision checks rather than silently overwriting history.

Process loss is recovered conservatively: admitted-but-unsent work retains its reservation, uncertain dispatch becomes `outcome_unknown`, and recorded responses retain their bytes even if decoding never finished. Accounting distinguishes reserved requests/pixels, dispatch attempts, recorded responses and unknown usage. Dispatch intent may overcount actual network packets; provider-confirmed usage and billed cost remain null without independent billing evidence. No provider idempotency or result-retrieval capability is assumed. No automatic retry occurs.

```sh
# Explicitly release global ownership; retained charges and unknown usage do not disappear.
npm run experiment:automatic -- release WORKFLOW_ID
# Prepare a new, explicitly linked authorization; this does not dispatch it.
npm run experiment:automatic -- prepare-replacement ORIGINAL_WORKFLOW_ID NEW_DIRECTORY [FROZEN_REFERENCE.json]
```

The original workflow remains non-runnable after release. Replacement plans reference it, obtain a new authorization identity, and require their own exact run approval. A previously registered reference is retained when a replacement does not supply another one.

Pixel references use `connector-pixel-reference-v1`: exact photograph hash, object ID, image dimensions, review identity/timestamps, provenance, and original-image `bbox` plus native `mask` regions for connector and conductors. `validRegion` can exclude uncertain/occluded pixels. Regions must be valid, the evaluated connector must be nonempty, and connector/conductor references cannot overlap within the valid region. References are validated and hash-registered before execution. Independently reviewed human masks enable photographic metrics; assistant boxes/points cannot. Synthetic fixtures are explicitly labeled and can only produce `synthetic_pass`, never photographic readiness.

On the valid region, IoU is intersection/union, connector recall is intersection/reference, precision is intersection/prediction, and conductor leakage is conductor intersection/prediction. Empty predictions have zero IoU/recall and undefined precision/leakage. Abstention, no-match, failures and unreviewed identities remain visible in the two-strategy denominator. Missing provenance disqualifies the affected arm. The provisional frozen gate requires correct identity for accepted masks, IoU ≥ 0.80, recall ≥ 0.90, leakage ≤ 5%, and zero request overage or missing provenance. Experiment execution performs zero identity merges; separate identity replay tests cover proposal permutation, jitter, conductor conflicts and immutable underlying SAM observations. These are engineering targets, not established recognition performance.

```sh
# Isolated generated source pixels and in-process fake provider; no .env or external inference.
npm run experiment:synthetic -- NEW_DIRECTORY
```

The synthetic suite exports source/checkpoint archives, full native request/response evidence, evaluation records, and SHA-256 manifests. It includes A/B success, point abstention, missing reference, valid empty output, parser failure, unknown dispatch and real SIGKILL recovery at admission, dispatch and response capture. It demonstrates workflow reliability; a real photographic test with independently reviewed masks and separately authorized inference is still required.

### Human connector annotation and retrospective validation

Open `/reference/ANALYSIS_ID/WORKFLOW_ID` in the workspace for a dedicated original-only annotation page. It fetches the orientation-corrected source photograph and the reviewer’s own draft; annotation GET, save and freeze responses contain no SAM prediction geometry. Brush labels are connector body, red insulation, black insulation and uncertain pixels. Erasing and undo are available, with 50–400% zoom. Coordinates remain original display pixels.

Draft saves use revision checks. Freezing requires visible foreground for the connector and both wires and creates an immutable `connector-reference-annotation-v1` version with original image hash, object ID, reviewer, annotation method, exposure declaration, timestamp, canonical reference hash and pixel masks. Masks use sorted, merged, end-exclusive horizontal `[y, xStart, xEnd]` spans. Classes cannot overlap; disputed pixels belong in the uncertain region. Corrections create new reference versions. Uncertain pixels are excluded from scoring and their count is retained in the reference metadata.

A human who has seen the prediction is recorded as **non-blinded human reference**. Such a reference can receive diagnostic metrics but cannot become blinded independent evidence or unlock the photographic connector gate. Independent qualification requires an assigned human reviewer, manual original-image annotation, never-seen prediction exposure and explicit attestation. Previously declared exposure cannot be erased by relabeling the same reviewer. These are recorded human attestations, not an automated claim that annotation accuracy has been independently certified. Automated tests simulate review metadata; they do not create real human ground truth.

Retrospective evaluation reads the saved native mask; it never reruns SAM. It stores a separate immutable evaluation linked to reference hash, original experiment/report/prediction hashes, source checkpoint, observation identity and the configured threshold hash. IoU, recall, precision, combined conductor leakage, and separate red/black leakage are reported. The original frozen plan, its absent preregistered reference and its A/B comparison status are preserved. Candidate A boundary acceptance is separate from A/B completeness. A passed A mask can satisfy the object gate while B remains abstained; non-blinded, unknown, assistant and synthetic references cannot unlock the real gate.

The audit replays the **recorded provider response locally**, checks native candidate/observation binding and deterministic public-preview agreement, and records Strategy B’s baseline eligibility rejection reasons. Audit version `automatic-point-audit-v1` describes the frozen `automatic-targeting-v1` filter; it does not substitute A output or reference pixels into B or silently change the targeting algorithm. If no eligible independent baseline evidence exists, B stays abstained. No new targeting algorithm or B request is introduced merely to eliminate abstention.

```sh
npm run connector:reference -- draft ANALYSIS_ID WORKFLOW_ID NEW_DRAFT.json
npm run connector:reference -- save ANALYSIS_ID WORKFLOW_ID SAVED_DRAFT_INPUT.json NEW_RESULT.json
npm run connector:reference -- freeze ANALYSIS_ID WORKFLOW_ID REVISION NEW_REFERENCE.json
npm run connector:reference -- evaluate ANALYSIS_ID WORKFLOW_ID REFERENCE_HASH NEW_EVALUATION.json
npm run connector:reference -- audit ANALYSIS_ID WORKFLOW_ID NEW_POINT_AUDIT.json
npm run connector:reference -- export ANALYSIS_ID WORKFLOW_ID NEW_PRIVATE_EVIDENCE.json
```

Every command above is offline and sends zero SAM/Muse requests. Save input is `{ revision, content }`. The UI is the preferred drawing workflow. A frozen reference may be reused for another saved prediction only when analysis, photo and object identities match; its original provenance remains unchanged.

Participating automatic connector analyses cannot initiate terminal discovery while any target connector gate is blocked. The server checks at queue admission, worker execution and immediately before provider transport; the UI shows the blocking reason. Gate validity requires current source evidence, the latest frozen reference/evaluation, unchanged prediction evidence, correct human physical identity and configured thresholds. Existing proposed terminal or electrical evidence is never promoted by these checks. Repeat connector inference is also blocked until independent annotation and offline evaluation are complete; each later request still requires its own bounded authorization.

Browser bundles include `connectorValidation` with reference metadata, retrospective metrics, gate decisions and private evidence links. Private JSON exports and offline job archives contain the complete reference spans, prediction/native masks, original request/response records and hashes. `evidence:export` includes `connector-validation/evidence.json` in its SHA-256 manifest. When no human reference exists, exports explicitly retain an empty reference collection, unavailable metrics and a blocked gate. No assistant-created annotation is substituted for the missing human step.

### Automatic targeting v2 (opt-in, experimental)

The default and historical `automatic-targeting-v1` A/B protocol are preserved.
Select the v2 targeting protocol in the workspace or prepare it offline with:

```sh
npm run scene:preview-targeting-v2 -- ANALYSIS_ID CONNECTOR_OBJECT_ID NEW_DIRECTORY
npm run experiment:connector -- prepare-auto-v2 ANALYSIS_ID CONNECTOR_OBJECT_ID NEW_DIRECTORY [FROZEN_PIXEL_REFERENCE.json]
```

The preview writes an immutable plan/protocol and crop images without registering
or spending a workflow. Registered v2 plans use the existing execution engine,
exact-plan authorization, stale-plan rejection, crash-safe accounting and no-replay
rules. Repeat connector spending still requires an independent reference evaluation;
preparation does not satisfy that guard. Limits remain three SAM requests, six
million pixels, two million pixels per crop, zero Muse calls and zero retries.

V2 declares three strategies: inventory box, mask-aware baseline interior, and
body-aware targeting. Per-observation diagnostics separate missing connector
associations, unavailable/corrupt native masks, conflicting conductor identities,
insufficient interior depth and pixel/uncertain-box exclusions. Only original broad
SAM masks supply baseline points. Unambiguous human-reviewed neighbor masks supply
pixel exclusions with a two-pixel margin; absent or uncertain masks retain box
exclusions. Wire identity is never inferred from proximity or insulation color.
Negative conductor points require reviewed native pixels and retain observation
and review IDs. All available native evidence hashes are retained in the plan.

The body proposal is a bounded `local_dark_core_v1` heuristic over the original RGB
crop: low-luminance, low-chroma connected interior cores, with fixed policy/hash,
minimum area/depth, ambiguity, boundary and thin-region rejection. It is intended
for investigating dark connector bodies. It is not general connector recognition
or a confirmed physical boundary. It may abstain, especially on occluded, bright,
wire-contaminated or adjacent dark objects. It consumes no reference pixels,
manual boundary profile or previous experiment predictions. The manual boundary
benchmark and automatic workflow share only spatial-prompt serialization.

`connector-comparison-protocol-v2` freezes algorithm/policy hashes, strategy names,
required comparisons, thresholds and reference qualification into the plan hash.
All three comparisons must finish; the body-aware arm must meet the configured
quality/identity gates. A/B baseline quality need not pass to validate an improved
C arm, but abstentions keep the comparison incomplete. Execution completion,
individual accepted masks and comparison completeness remain distinct. The legacy
`abComparison` export field denotes completeness of all declared arms in v2.

V2 reference provenance records method, prior prediction exposure, original-only
annotation, human attestation and reviewer. `independent: true` alone cannot qualify
it. Assistant and non-blinded references can yield diagnostic scores but cannot
unlock independent photographic acceptance. Retrospective v2 scoring uses the same
strict frozen annotation workflow, defaults to the body-aware arm, and cannot pass
the connector gate with incomplete comparisons. Synthetic passes never unlock it.
Use held-out independently annotated photographs to assess generalization; no
photographic improvement is established by synthetic fixtures or an offline plan.

When both improved v2 strategies abstain, execution is additionally blocked with
`TARGETING_EVIDENCE_REQUIRED`; an inventory-box-only preview cannot spend a repeated
request. Body pixel diagnostics report dark foreground before exclusion, reviewed
mask exclusions, uncertain-box exclusions, remaining pixels and interior cores.
They distinguish missing visual support from uncertainty imposed by neighboring
hypotheses without treating box overlap as physical contact.

### Phase 4B: connector junction discovery

The workspace now has a **Connector junction discovery** section. It operates on
one connector and two explicitly selected conductor object IDs. Preparation is
local and requires the exact independently accepted `C-body-aware-v2`
connector-only native mask, including its validation, identity review, photograph
and scene bindings. An object-level gate or approximate inventory box alone is
insufficient. The prerequisite is checked again at admission and transport.

The worker reuses the existing scene/terminal queue, ownership lease, model
admission and request-evidence recorder. There is no new segmentation pass. It
samples all sides of the mask boundary within a frozen eight-pixel search band;
reviewed, unambiguous native conductor pixels may supply proximity candidates.
Unverified boxes supply search regions only, with no junction position or claim
of attachment. The crop is the native mask extent with 24 source pixels of context.

Preparation freezes both the original JPEG crop and a separately identified
proposal overlay, their hashes, native-mask hash, source checkpoints, candidate
regions, model/provider and request payload hash. Both images count toward input
pixels. **SAM requests are always zero; Muse requests are zero or one, with no
retries.** Muse is opt-in and the run requires authorization for the exact saved
provider, request count and pixel allowance. Offline completion yields exactly
two unresolved outcomes. Model interpretation likewise returns two conductor
outcomes or a precise failure/uncertainty record, never another inference stage.

Junction observations are stored separately from generic electrical terminals.
A visible `housing_entry` may have a physical position while its hidden conductive
contact remains unlocated. `exposed_contact` requires an actual visible contact.
Colors are descriptive clues only. Polarity, continuity and electrical connections
remain unestablished. Model confidence is an uncalibrated estimate, not acceptance.
Model proposals cannot confirm associations; only explicit visible-evidence human
reviews can do so. Marker corrections reuse the current image and original pixel
coordinates, with numerical entry available for keyboard review. Reviews append
without altering model observations; stale revisions fail closed.

One admitted attempt is allowed per connector/image/native-mask/two-conductor
scope. Preparation is idempotent. Repeated admission, generic-terminal bypass and
scene retry are blocked after that bounded attempt. Dispatch intent is committed
before transport. A lost response remains charged and unknown; a worker restart
never silently resends it, and late workers cannot overwrite recovered evidence.
Two outcomes remain available even after occlusion, invalid output or interruption.

A small point-reference JSON can be uploaded through the panel for offline
benchmarking; no additional drawing tool is introduced. Its content includes:

- `imageHash`, `connectorObjectId`, reviewer label and source;
- `annotationMethod`: `manual_point`, `assistant_proposal` or `synthetic_fixture`;
- declared `predictionExposure`, `originalImageOnly` and human attestation;
- exactly two `junctions`, each with conductor ID, kind, visibility and nullable
  original-image `[x,y]` position.

Only an attested original-only manual human reference with declared no prior
junction-prediction exposure can qualify as independent; an exposed reviewer
cannot regain that status by changing a Boolean. Assistant and non-blinded
references remain diagnostic. Hidden contacts and visible housing entries are
scored as different claims. The five-pixel Euclidean localization threshold is
an initial protocol, not established photographic accuracy. Zero visible reference
junctions leaves localization incomplete rather than reporting a perfect score.

Original proposals and human-reviewed outcomes are scored as separate layers, so
corrections cannot hide an automatic failure. Exports include localization errors,
visible coverage, abstentions, incorrect confirmed claims and their denominator,
provenance coverage, accounting and latency. `wrongConfirmedAssociations` is a
conservative count of invalid confirmed junction claims, including wrong kind or
out-of-tolerance position. An evaluation never automatically confirms an outcome
or establishes an electrical connection.

Public scene evaluation bundles include `connectorJunctions`. The private
`connector-junction-evidence` download and full job archive include the native
connector mask, frozen upstream acceptance/reference evidence (not supplied to
Muse), original crop/overlay, raw request/response, observations, reviews,
references, scoring results and hashes. Analysis deletion/retention also removes
the associated local junction records; downloaded archives remain self-contained.

`npm run fixture:junction-ui` regenerates the synthetic UI fixture with in-memory
storage and mocked transports. The simulated prerequisite reviewer metadata in
that fixture is not evidence about any real photograph. Tests cover gating,
boundary search, contact/entry separation, strict response IDs/coordinates,
one-request accounting, uncertainty, stale plans, immutable reviews, independent
reference qualification, five-pixel scoring, crash/lease fencing, rollback, HTTP
routing, image correction and export preservation.

The accepted-mask resolver materializes the exact pixels used by C's validation.
If C was scored with the recorded keep-dark-halo refinement, Phase 4B reconstructs
that subset and checks its scores against the frozen reference before admission.
Raw SAM bytes, accepted-raster runs/hash, refinement hash and tight accepted bounds
are preserved separately; boundary search and the overlay use the accepted raster,
not a larger unfiltered native candidate. Unknown/missing refinement provenance
fails closed. Private downloads also retain the source photograph and prepared
image checkpoint, so original coordinates and mask provenance remain verifiable
without the live job store.

## Phase 5A — deterministic electrical connectivity

The Connectivity panel extends the current photograph workspace. It does not
send SAM or Muse requests and does not start another analysis lifecycle.
Calibration and endpoint records remain usable through their existing controls;
**Save calibration and endpoint evidence** persists their original records in the
saved analysis. On reload, the saved board/rail geometry, assignments and endpoint
reviews are restored. The former photograph-local geometry implementation now
lives in `server/src/shared/calibration.ts`; the frontend exports that same code.

Saving a hole assignment does **not** confirm electrical contact or wire identity.
The graph requires explicit review of board topology, each required insertion or
external conductive contact, and same-wire identity/intact continuity. Component
terminal roles require a stated identification source; no polarity or transistor
pin order is generated from image position or wire color. Unrecognized components
can be added manually, with unknown roles. Duplicate or irrelevant hypotheses may
be explicitly excluded with a retained review reason; they are not automatically
merged by labels or overlap. Connector junction/scene evidence is retained as
physical hints and never promoted to electrical contact.

The graph unions only confirmed topology, confirmed conductive contact and intact
conductors. Resistors, LEDs, LDRs, transistors and supplies are typed devices, not
zero-resistance edges. Separate strips, the center gap and declared rail breaks
remain separate until a confirmed conductor bridges them. Unknown rail continuity
never becomes a bus. Every edge retains its source evidence and every node lists
its physical members. Terminal display anchors may use the confirmed hole's
projection when no separate lead-position observation exists; that projection is
not an independently localized physical contact.

All mutations require the current evidence revision, reviewer and reason.
Original import records and both previous and reviewed values remain in immutable
events. Calibration/scene/model changes invalidate dependent evidence or block
construction; a rebuild never silently re-snaps old insertions. Rebuilding the
same evidence is idempotent. A graph can be rebuilt after restart without model
work. Job deletion/retention removes its associated connectivity artifacts.

The first rule compares a required same-net relationship and identifies a
misplaced jumper only when its confirmed endpoints and the reference mapping
support that attribution. Alternate confirmed paths and equivalent holes on the
same strip prevent a false disconnection finding. A missing path requires explicit
**conductive review coverage** before it can become `confirmed_fault`: the
reviewer must account for relevant conductive paths, including paths omitted from
recognition. Any later evidence mutation invalidates this coverage assertion.
Otherwise the result remains `possible_fault` or `insufficient_evidence`.
`no_fault` means only that the selected required relationship is present; it is
not a full-circuit or illumination guarantee.

Reference JSON contains a `reference` and explicit one-to-one component `mapping`.
The reference declares components, terminal roles, nets, one or more
`required_conductive_path` rules and schematic provenance. Verified human
references containing an NPN transistor require its exact `partNumber`, `package`
and `pinoutSource`. Reference specifications and mappings are immutable once
registered; corrections create a new registered reference. Synthetic and draft
references remain clearly labeled and cannot establish real-photo acceptance.
See `server/fixtures/reference-night-light.synthetic.json` for the abstract
synthetic netlist; it intentionally specifies no physical transistor package or
pin order.

Analysis-scoped API actions (all local, without inference):

- `GET /api/analyses/:id/connectivity`
- `GET /api/analyses/:id/connectivity-evidence`
- `POST /api/analyses/:id/save-connectivity-workspace`
- `POST /api/analyses/:id/review-connectivity`
- `POST /api/analyses/:id/build-connectivity`
- `POST /api/analyses/:id/register-connectivity-reference`
- `POST /api/analyses/:id/compare-connectivity`

The UI highlights selected nets, connections and supported fault destinations on
the existing image. Green represents confirmed graph relationships; dashed amber
markers represent unresolved associations. Confirm/correct terminal associations
using the existing calibrated hole picker, or select another known terminal for
an explicitly reviewed external contact. Historical graphs are marked stale and
cannot support a current comparison. Unsaved workspace changes also block review,
rebuild and comparison until persisted.

**Export connectivity evidence**, the existing evaluation bundle and the full
private job archive include graph/review/reference/diagnostic evidence. The complete
connectivity download retains every immutable graph revision, so earlier fault
findings remain linked to their original graph after a correction. The private
archive also retains the original image and analysis checkpoints. The browser
bundle records unsaved local geometry separately so it cannot masquerade as the
source of a previously built graph.

Run `npm run connectivity:evaluate` from `server` for the controlled synthetic
correct-circuit and misplaced-jumper comparison. It uses only in-memory jobs,
regenerates the synthetic frontend fixtures and emits an offline evidence report.
It never opens historical user analyses or uses a provider transport. Tests cover
registered topology, device separation, unresolved/rejected contact, explicit
coverage, equivalent holes, alternate paths, corrections, revision conflicts,
persistence/replay, HTTP contracts, UI picking/highlighting and export.

Physical Phase 5A acceptance remains pending. Required real demonstration inputs:
a selected saved night-light analysis and source photograph, its intended schematic
or verified netlist, actual component values where relevant, the transistor's exact
part/package and verified pinout, and confirmed physical associations for the
chosen deliberately misplaced jumper and its required destination net. A synthetic
pass or a rendered graph does not satisfy that acceptance test.
