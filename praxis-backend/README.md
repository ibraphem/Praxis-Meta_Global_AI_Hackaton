# Praxis backend

Praxis's first milestone is still-image perception: upload a photograph and receive
a structured list of visible **breadboards, LEDs, resistors, and jumper wires**.
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

- Node.js **22.12 or later**, with npm. An active Node.js LTS release is recommended.
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

| Variable                  | Default                  | Purpose                                                                                     |
| ------------------------- | ------------------------ | ------------------------------------------------------------------------------------------- |
| `META_API_KEY`            | Required                 | Server-side Meta credential                                                                 |
| `META_BASE_URL`           | `https://api.meta.ai/v1` | Trusted administrator-configured HTTPS endpoint; no redirects                               |
| `META_SAM_MODEL`          | `sam-3.1`                | Account-accessible SAM model                                                                |
| `META_REASONING_MODEL`    | `muse-spark-1.3`         | Account-accessible Muse model                                                               |
| `VISION_MODE`             | `combined`               | `combined` or `reasoning-only`                                                              |
| `HOST` / `PORT`           | `127.0.0.1` / `3000`     | Bind address and port                                                                       |
| `NODE_ENV`                | `development`            | `development`, `test`, or `production`                                                      |
| `PRAXIS_API_TOKEN`        | Unset                    | Separate bearer token, 32–256 characters                                                    |
| `MAX_UPLOAD_BYTES`        | `8388608`                | 8 MiB input file limit                                                                      |
| `MAX_IMAGE_PIXELS`        | `16000000`               | Maximum decoded pixels                                                                      |
| `MAX_CONCURRENT_ANALYSES` | `2`                      | Per-process upload/decode/inference slots; excess requests rejected                         |
| `MAX_WIRE_REFINEMENTS`    | `6`                      | Maximum Muse regions in the optional spatial SAM batch (0–16)                               |
| `REFINEMENT_TIMEOUT_MS`   | `15000`                  | Optional batch deadline (maximum 45000), capped by provider and overall budgets; no retries |
| `SAM_CONCURRENCY`         | `2`                      | Maximum simultaneous SAM concept calls per analysis (1–4)                                   |
| `ANALYSIS_TIMEOUT_MS`     | `180000`                 | Overall upload/analysis deadline (maximum 300000)                                           |
| `PROVIDER_TIMEOUT_MS`     | `45000`                  | Per-attempt provider deadline, including response reading (maximum 120000)                  |
| `PROVIDER_MAX_RETRIES`    | `1`                      | Extra attempts for network failures, timeouts, HTTP 429 and 5xx                             |
| `RATE_LIMIT_MAX`          | `20`                     | Requests per client IP per window                                                           |
| `RATE_LIMIT_WINDOW_MS`    | `60000`                  | Rate-limit window                                                                           |

## Security and privacy

- A bearer token is required in production and whenever binding beyond loopback.
  Generate a distinct random token, for example with `openssl rand -hex 32`.
- Authentication precedes image processing. Token comparisons use fixed-length
  hashes and constant-time comparison. Use TLS at the deployment boundary.
- Browser Origin requests are currently rejected, and CORS is disabled. Add an
  explicit origin allowlist when integrating the frontend. A shared backend token
  is not a substitute for user authentication in a public application.
- Uploads are processed in memory and are not saved. Image metadata is stripped
  before submission, but **the photograph is sent to Meta**; provider handling and
  retention depend on your account's terms. Memory is reclaimed normally, not
  guaranteed to be securely erased.
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
One retry is allowed for transient failures; the overall deadline still bounds
the entire operation. These limits reduce premature timeouts, not provider latency.
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

`POST /api/vision/endpoints` accepts multipart `image` plus one JSON text field
`context`: `{ analysisId, imageId, image: { width, height }, wire: { id, bbox, mask } }`.
The wire must be a selected SAM-segmented candidate; `bbox` is original-image
`[x,y,width,height]` and `mask` is the existing bounded SVG path contract. No image
or analysis is retained on the server, so the caller supplies this context each
time. IDs correlate the reply; they do not authenticate an analysis stored here.
The photograph is decoded/rotated with the existing image preparation service, and
context dimensions and bounds are checked before inference.

One structured Muse call returns ordered endpoints A/B with
`proposedImagePosition: [x,y] | null` in original-image pixels and evidence
`visible_insertion`, `visible_connector`, `wire_mask_tip`, `occluded`, or
`insufficient`. Hidden/insufficient positions must be null. Invalid roles,
out-of-image positions and invented hole fields fail closed. The response echoes
the analysis/image/wire IDs and configured model, with `muse.endpoints` timing.
The frontend, using user-confirmed calibration and registered rails, resolves
pixels to holes and obtains independent user review. This API does not confirm
wire identity, electrical contact or continuity, and never returns hole IDs.

The route shares authentication, browser-origin rejection, rate limiting,
concurrency admission, upload bounds, deadline/cancellation and sanitized errors
with analysis. The Next proxy exposes the same endpoint without revealing server
credentials. No new environment variables are required. Fixture tests cover the
provider contract, invalid output/context, HTTP transport and shared capacity;
they make no external model calls.
