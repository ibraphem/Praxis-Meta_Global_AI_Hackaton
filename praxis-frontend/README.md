# Praxis — vision workspace

A mobile-friendly Next.js interface for Praxis's first perception milestone.
Upload a photograph, send it to the backend, and inspect the returned breadboards,
LEDs, resistors, and jumper wires directly over the image.

## Recoverable analysis and partial results

**Analyze image** now uploads once to `/api/analyses`. The backend saves the photograph
and creates a job, then the UI polls progress. SAM results survive Muse timeouts,
browser disconnects and backend restarts. The page URL contains `?analysis=UUID`;
reopen that link to reload the saved photograph and results without another upload
or model call. Only queued work is dispatched automatically after restart. Running
attempts with an expired worker lease become **interrupted**, requiring manual retry.

When interpretation fails, use **Continue with SAM candidates** for calibration and
manual endpoint assignment, or **Retry Muse interpretation** to reuse saved masks.
Candidates remain explicitly unverified, including board regions that might be
fragments of one physical board. Muse retry performs zero SAM requests. The persisted queue defaults to one active
job independently of legacy requests. An uncertain
upstream outcome is disclosed; manual retry may duplicate provider work that outlived
the local deadline. Duplicate clicks cannot create concurrent attempts for one job.

**Pause updates** stops browser observation; server execution continues. **Reconnect
to saved analysis** fetches current state. **Delete saved analysis** removes an inactive
job. Clearing the photograph only clears the local workspace; it does not delete the
server job. Stage attempts and timings appear in the saved-analysis panel.

By default the backend retains up to 100 jobs for 24 hours in its private, gitignored
`.praxis-jobs` SQLite directory. Mount persistent local storage when deploying the
long-running backend. Endpoint reviews/calibrations remain browser-memory state and
are not restored by the job link; export evaluation bundles to retain those. Muse
completion changes the review run identity so old assignments cannot silently follow
renumbered candidates. Each stage is limited to 20 attempts.

Muse uses one automatic attempt and a default 45-second deadline, with no automatic
retry on timeout. Full-size imagery and the existing prompt remain the defaults;
resized inputs and a minimal prompt are opt-in server experiments. See the
[backend recovery and controlled comparison guide](../praxis-backend/README.md#recoverable-analysis-jobs).
The dedicated endpoint API and opt-in local color-tip refinement remain separate.

Queue experiments reserve model admission across the backend database. The UI shows
running/interrupted reservations and suppresses manual retry while reserved. Saved
results remain reviewable. New Muse attempts and evaluation bundles include immutable
SAM checkpoint identity/hash; migrated historical bindings are marked inferred.
For evidence that must outlive retention, use the backend's offline `evidence:export`
command and include your separately recorded ground truth and browser evaluation
bundle. See [benchmark evidence retention](../praxis-backend/README.md#preserve-benchmark-evidence-beyond-job-retention).

## Run locally

Use Node.js 22.13 or later (the backend uses built-in SQLite) and install the frontend dependencies with `npm ci`.

First, start the backend in a separate terminal:

```sh
cd praxis-backend/server
npm run dev
```

The backend reads **`praxis-backend/server/.env`**. Set `META_API_KEY` there.
A `.env` at `praxis-backend/.env` is not loaded by its scripts. Check the
[backend README](../praxis-backend/README.md) for model access and configuration.

Then, from `praxis-frontend`:

```sh
npm ci
npm run dev
```

Open **http://127.0.0.1:3001**. The backend defaults to port 3000; the frontend uses
3001 so they can run together. Both development services bind to loopback.

The default backend URL works without a frontend env file. If the backend uses a
different address or requires a token:

```sh
cp .env.example .env.local
```

Configure these **server-only** variables and restart Next.js:

| Variable                  | Default                 | Purpose                                                                  |
| ------------------------- | ----------------------- | ------------------------------------------------------------------------ |
| `PRAXIS_BACKEND_URL`      | `http://127.0.0.1:3000` | Backend root URL; HTTPS required except on loopback                      |
| `PRAXIS_API_TOKEN`        | Unset                   | Same value as the backend's token, if configured                         |
| `PRAXIS_PROXY_TIMEOUT_MS` | `190000`                | Overall proxy deadline, up to 330000 ms; keep above the backend deadline |

Do not prefix these variables with `NEXT_PUBLIC_`. Meta credentials belong only in
the backend. No credentials are included in the browser bundle.

## Use the workspace

1. Choose or drop **one JPEG, PNG, or WebP**, up to **8 MiB and 16 megapixels**.
2. Inspect the local preview, then choose **Analyze image**. Selection alone does
   not send the photograph anywhere.
3. Wait for the backend result; cancel, remove, or replace the photo if needed.
4. Select a component in the results list or on the image to inspect it. Toggle
   overlays off to compare against the original photograph.
5. Expand **Inspect response JSON** to see the complete structured result and
   configured model IDs.

The counts, boxes, colors, scores, and analysis duration come from the actual run;
the UI contains no fabricated detections. Optional confidence is labeled **SAM
score** and is omitted when unavailable. An uncertain interpretation is marked
explicitly. Empty detections, invalid uploads, timeouts, and backend errors have
separate states. Model output is not proof of correct electrical wiring.

Wire candidates are rendered using SAM segmentation contours. Clicking the
painted mask or its label selects that candidate; the broad bounding rectangle is
not a clickable individual-wire target. Muse supplies approximate search regions
and targeting points for a bounded second SAM pass. Successfully refined candidates
are labeled **Recovered candidate**, localized by SAM, and remain **Uncertain**.
Available scores are SAM's, never Muse confidence.

Unresolved hypotheses appear separately as **Wire region A, B, …**, with dashed
amber outlines and an explanation when selected. Their interiors are not wire
selection targets. They may contain several wires or duplicate observations and
are excluded from component/wire counts. A failed or timed-out optional refinement
retains the other detections. Inspect `proposals`, `provenance.wireAudit`, and the
`sam.wire_refine` / `wire.geometry` timings in the response JSON.

All wire identities remain unverified and `guidanceEligible: false`. Masks can
still be wrong, especially at crossings and occlusions. Numbers reset on every
analysis. Persistent tracking, connector verification and physical-action guidance
are outside this milestone. Reasoning-only backend mode returns wire regions
rather than numbered wire candidates because SAM geometry is unavailable.

## Breadboard counts and grouped regions

Combined-mode analysis distinguishes SAM breadboard regions from physical board
instances. Muse reviews whether regions represent a whole board or sections of
the same assembly. Supported groups become one breadboard in the results; raw
sections do not each increase the count. Separate adjacent boards are not merged
by box proximity alone.

**Grouped SAM regions / DERIVED BOX** means the enclosure was calculated from
several region boxes; it has no combined SAM score. **Whole-board SAM region**
uses an existing enclosing whole-board candidate and retains only that candidate's
optional score. Neither establishes calibration accuracy or electrical correctness.

Ambiguous observations appear under **Unresolved board regions**, with separate
amber outlines and labels such as **Board region 1**. Select a region to inspect
its extent and optional SAM region score. These observations are excluded from
physical-board and total-component counts; zero counted boards can coexist with
unresolved regions. **Inspect response JSON** exposes each object's
`breadboardGrouping` and the original candidate geometry/scores under
`breadboardAudit`, including rejected candidates and `unresolvedCandidateIds`.

Restart the backend and frontend and reanalyze the photograph to use the updated
review contract. Compiled services must be rebuilt first. Existing results do not
change retroactively. This uses the existing Muse call and adds no extra model
request. Grouping can still be wrong and needs evaluation on real photographs.
Manual calibration IDs remain separate from model detection IDs.

## Breadboard coordinates — Step A

Upload a photograph, then choose **Calibrate a board** above the preview. This
works independently of model analysis and makes no additional API calls. The
supported template is a standard ten-column terminal grid with **30 or 63 rows**,
2.54 mm hole pitch, and a three-pitch separation between e and f. It is a template
family, not automatic board-model recognition; verify that your board matches it.

1. Select the row count before setting reference points.
2. Click the **hole centers** in order: **a1 → j1 → j30 → a30** (use 63 for
   a full board). All four reference holes must be visible. Follow the printed
   lettering/numbering; on an unmarked board, the chosen order defines the
   coordinate convention. The plastic corners and SAM's rectangle are not anchors.
3. Inspect the projected holes across the entire board, especially interior
   rows and both sides of the center gap. The reference diagram and named markers
   distinguish terminal holes from rails. Select any named reference button to
   replace just that point; the other three stay fixed. Use **Reset all points**
   to restart, or **Cancel replacement** to keep the existing point. Select
   **Grid aligns — confirm** only when the overlay matches.
4. Click near a visible hole center to see its logical coordinate and electrical
   group. The group is highlighted on the image. Clicks more than 0.32 hole
   pitches from a center, ambiguous overlaps, center-channel clicks, and
   background clicks return no match.
5. Use the magnified original-image detail and crosshair to inspect a hole
   before clicking. The loupe uses a 48 × 48 source-pixel window and never includes
   inferred overlays. Its readout and placement use the same original-image
   coordinate. After the pointer leaves, it shows the selected/last reference.
6. Use **Photo zoom** (up to 300%) and scroll for small holes. Pixel-coordinate
   entry provides a keyboard alternative to image clicks, and **Show coordinate**
   locates a named template hole such as `a12`. Coordinate lookup does not establish
   that the hole is visible in the photograph.

Calibration presentation is loaded with the image preview through a scoped CSS
module. The Turbopack Tailwind loader processes only the global entry stylesheet,
so CSS modules retain Next.js's native scoped class names. The guide and magnifier
include bounded SVG dimensions even before the
stylesheet loads. The magnifier reserves the same viewport in its empty and
populated states, so hovering does not resize the helper and move the photograph.
The helper responds to the width of the photo panel, including layouts with a
results sidebar. Photo zoom affects the scrollable photo viewport only.

Invalid or crossed reference points show **Correct the reference points**, without
requesting grid alignment review. Confirmation remains disabled until the geometry
is valid and a pending point replacement has been completed or cancelled. The
same distinction applies to invalid rail registration. Pointer coordinates are
measured against the actual rendered `<img>` rectangle using browser client
coordinates; no device-pixel-ratio multiplier is applied. The loupe clears its
hover position on scroll/resize so it cannot retain a stale cursor location.

Four ordered anchors establish orientation and a projective homography. It maps
between original photograph pixels and the known grid; Muse does not locate
individual holes. Convexity, finite coordinates, image bounds, perspective stability
and minimum source-image hole spacing are checked. The blue terminal strips and
amber center gap are geometric overlays. A four-point fit is not an independent
accuracy measurement: misidentified anchors, lens distortion, occlusion, and
nonstandard boards can still produce a wrong grid. There is no automatic visibility
check, lens correction or calibration-quality confidence score.

For the supported template, a12–e12 share one group and f12–j12 share another.
Different rows and different boards remain separate. Up to four manually
calibrated boards can coexist; use the Board selector to inspect one at a time.
Manual board IDs are photograph-local and independent of SAM's detection IDs.

### Power rails

Rails are **not inferred** from terminal-grid corners or colored stripes. Choose
**Register rail lane** after confirming a grid and mark the first and last hole
centers of one lane. Choose 25 or 50 holes, and either uniform spacing or groups of
five separated by a one-pitch gap. Check the projected rail holes before saving;
unsupported patterns must remain unregistered. Up to four lanes are supported,
with identifiers such as `R1:5`. Rail numbering follows your first-to-last order.

Continuity defaults to **Unknown**, giving `electricalGroup: null`. Only an
explicit declaration from board documentation assigns a continuous bus or a split
at a specified hole. A +/− label is descriptive; it establishes neither continuity
nor voltage. Different lanes are never automatically joined. These declarations
and template rules do not measure actual contact or continuity. See the
[manufacturer's BB830 description](https://busboard.com/BB830T) for a representative
630-terminal/four-rail board, and
[Adafruit's split-rail guidance](https://learn.adafruit.com/breadboards-for-beginners/breadboard-tips-and-tricks)
for why rail continuity cannot be assumed.

### Inspect spatial data

The selected hole exposes its own JSON, separate from the AI analysis response.
For example (illustrative geometry):

```json
{
  "breadboardId": "board_1",
  "hole": "a12",
  "kind": "terminal",
  "electricalGroup": "board_1:terminal-a-e-12",
  "groupBasis": "template",
  "groupMembers": ["a12", "b12", "c12", "d12", "e12"],
  "imagePosition": { "x": 180, "y": 360 },
  "calibrationSource": "manual",
  "selectionSource": "image_click",
  "visibility": "unverified",
  "electricalContact": "unknown"
}
```

`groupBasis` distinguishes template connectivity, user-declared rail continuity,
and unknown continuity. `selectionSource` distinguishes image clicks, pixel entry,
and coordinate lookup. **Inspect calibration JSON** exposes ordered anchors,
image dimensions, forward/inverse matrices, local image-axis orientation angles,
rail definitions and the user-confirmed status. Angles are clockwise from image
right at the grid center; a single angle does not describe perspective everywhere.

Calibration and selections stay in component memory; analyzed photographs also persist in the backend job store. Replacing or
removing the image, or reloading the page, clears them. Reanalyzing the same photo
preserves calibration. Recalibrating a board clears its rails to avoid stale
geometry. **Inspect components** restores ordinary detection selection without
removing the calibration. The backend analysis response remains unchanged;
calibration is currently a client-side feature.

## Wire endpoints — Step B, manual assignment

1. Analyze a photograph and confirm at least one breadboard calibration.
2. Return to **Inspect components** and select an existing **segmented wire
   candidate** in the photograph or results. An unresolved Muse search region is
   not an assignable wire.
3. Choose **Assign wire endpoints** below the photograph. Select the board for
   the first endpoint, then click its visible insertion position. Original-image
   pixel entry is available as a keyboard alternative. Photo zoom remains available.
4. When the first position resolves to a hole, picking advances to endpoint 2.
   Choose another calibrated board if necessary, then select the second position.
5. Inspect the connection, for example **board_1:a12 → board_2:f18**, its numbered
   endpoint markers and **Inspect assignment JSON**. The selected wire retains its
   original SAM contour; a straight line between the markers is not substituted
   for the wire's shape. Use **Replace endpoint** to correct a selection, **Stop
   picking** to pause, or **Remove record** to discard the assignment.

The active board is explicit: overlapping boards are never silently chosen. A
point is resolved using Step A's bounded hole-picking rules. An ambiguous position,
center gap or background remains **unknown** and the record remains a draft;
pick a clearer position or select the other endpoint in the record. Registered
rail holes can be located even when their electrical group is unknown. Coordinate
lookup alone cannot assign an endpoint, because it does not establish visibility.

Three evidence states remain independent:

| Evidence           | Current state                              | Meaning                                                                                                                     |
| ------------------ | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| Wire identity      | `unverified`, association source `user`    | The user associates these observations with the selected candidate; the mask does not prove one physical wire.              |
| Endpoint location  | `user_selected`, selection source `manual` | The raw observation is retained alongside a resolved calibrated hole or an unknown result. No location is labeled inferred. |
| Electrical contact | `unknown`                                  | A selected hole and a visible connector do not establish seating or continuity.                                             |

**Manually assigned** means both observations resolve to logical holes. It does
not verify wire identity, visibility, connector insertion, or electrical contact.
These records do not enable physical-action guidance or change `guidanceEligible`.
The AI review layer described below complements manual picking; it does not verify
connector seating or electrical contact.

Assignments are stored separately from `Analysis.objects`; the original SAM/Muse
response JSON is unchanged. Each record carries the photograph ID, a client-side
analysis-run ID, the wire candidate ID, and a calibration revision per endpoint.
The client run ID is separate from the request ID used for backend diagnostics.
Raw selected pixels and snapped hole centers are both preserved, with input method,
snap distance, electrical-group basis and endpoint provenance.

Confirming recalibration, adding/removing a rail or changing its continuity
advances that board's revision and invalidates associated records. Removing a
referenced board also invalidates them. Unrelated board edits and cancelled
calibration drafts leave them current. Starting another analysis invalidates the
old records even if the request later fails/cancels or the new result reuses wire
numbers. Stale records remain visibly labeled for inspection, cannot be edited,
and their markers are hidden; they are never silently re-snapped or revived.

All records stay in photograph-local component memory, capped at 100 records.
Replacing/removing the photograph or reloading the page clears them. There is no
server persistence, browser storage, additional upload or additional model call.

## Request flow and security

`Browser → POST /api/vision/analyze (Next.js) → Praxis backend → Meta`

The Next.js route forwards the upload to a fixed, administrator-configured backend
and adds its token on the server. The existing backend does not need CORS changes.
The proxy never forwards browser cookies, browser authorization, or Origin headers.
Browser cross-origin submissions are rejected. Redirects are disabled so the token
cannot be forwarded to a redirect destination.

The proxy bounds uploads while reading the stream (including requests without
Content-Length), limits itself to two concurrent requests per process, enforces a
190-second deadline by default, caps backend responses at 256 KiB, validates returned objects, bounded numeric SVG paths,
regions and coordinates, and returns curated errors instead of raw provider messages.
The backend independently validates files, decodes images, and applies its own
limits. Client-side checks are convenience checks, not a security boundary.

## Inspect timeout diagnostics

Timeouts retain their distinct codes: `PROVIDER_TIMEOUT` (the backend waiting for
one Meta request), `META_API_TIMEOUT` (Meta returned 504), `ANALYSIS_TIMEOUT`
(backend's overall deadline), and `PROXY_TIMEOUT` (the Next server's deadline).
Cancellation is `REQUEST_CANCELLED` / HTTP 499. Unrecognized upstream 504s become
`BACKEND_TIMEOUT`; the proxy does not guess which timer expired.

The error panel shows source, stage, model, attempt, duration and deadline where
available, plus the request ID, a per-stage timing table and diagnostic JSON.
Successful runs expose their timings under **Inspect response JSON** as well.
One UUID correlates frontend and backend logs; only known timeout codes and
schema-validated diagnostic fields cross the proxy. Raw upstream messages are
discarded. Neither service logs photographs, prompts, credentials or model output.

Restart both services after upgrading, and rebuild first if using `npm start`.
Default budgets are 45 seconds per Meta attempt, 180 seconds overall in the backend,
and 190 seconds at the Next proxy. Existing environment values override defaults.
The route's `maxDuration=360` is a deployment hint, not another local application
timer. Your hosting platform may impose its own limits; those cutoffs cannot always
be classified by application code. See the [backend diagnostics guide](../praxis-backend/README.md#diagnose-a-timeout).

Browser previews stay in component memory and blob URLs are revoked on replacement.
The job API now persists photographs and results in the backend's private store for
recovery; photos do not enter browser storage. Responses are `no-store`. Provider
requests send the photograph to Meta, subject to your account terms. Pausing browser
updates does not cancel provider execution.

This milestone is a **local evaluation UI**, not a public authenticated service.
Before public deployment, protect the Next route with user authentication and
shared rate limiting. A backend token authenticates the proxy, not visitors.
For multiple server instances, use shared admission/rate controls. Deployment
platforms must support at least the upload size and analysis duration above.

## PWA foundation

Includes an App Router manifest, standalone display mode, theme metadata, app and
maskable icons, an Apple touch icon, and responsive touch-friendly layouts. There
is no service worker, offline analysis, camera capture, or push notification flow
in this milestone. Analysis requires a working backend and internet connection.
Use HTTPS for deployment and device installation; browser installation behavior
varies. No uploaded photographs or API responses are cached for offline use.

## Validate and build

```sh
npm run typecheck
npm test
npm run build
```

Proxy tests inject a fake backend and cover request forwarding, token isolation,
cross-origin rejection, upload/response limits, schema validation, error
sanitization, cancellation, and concurrency. They do not call Meta or establish
real-world detection accuracy. Geometry tests cover mask rendering, distinct
region labels, count separation, and rejection of unsafe or guidance-ready output.
Breadboard geometry tests project every hole under multiple orientations and
perspective transforms, check grouping and rail splits, reject invalid calibrations
and background clicks, and verify zoom/scroll coordinate conversion.
Endpoint tests cover cross-board resolution, raw versus snapped positions,
unknown holes and rail continuity, separate evidence states, immutable detection
results, edits, calibration/rail revisions, board removal, repeated wire IDs after
reanalysis, stale-record presentation and endpoint overlays.
Browser QA should also exercise upload, analysis,
selection, empty scenes, errors, and the mobile layout.

For a compiled local server, run `npm start` after building. It also uses port 3001.

## Code map

- `lib/breadboard/calibration.ts`: template, perspective transform, grouping, rail registration and bounded hole picking.
- `components/breadboard-workspace.tsx`: manual calibration, confirmation, zoom and coordinate inspection.
- `components/breadboard-workspace.module.css`: scoped calibration layout, bounded helper viewports, and panel-width responsiveness.
- `components/calibration-guide.tsx`: named terminal-grid reference diagram.
- `components/calibration-loupe.tsx`: original-pixel magnification and crosshair.
- `lib/breadboard/references.ts`: stable reference slots and valid/invalid workflow instructions.
- `components/breadboard-overlay.tsx`: terminal, gap, rail and selected-group geometry.
- `components/vision-workspace.tsx`: upload, preview lifecycle, cancellation, and requests.
- `components/image-preview.tsx`: image-relative component overlays.
- `components/wire-overlays.tsx`: mask selection and separately labeled search regions.
- `lib/wires/assignments.ts`: separate manual records, hole resolution, evidence states and revision-based invalidation.
- `components/wire-assignment-panel.tsx`: manual picking, board selection, partial/stale records and assignment JSON.
- `components/wire-endpoint-overlay.tsx`: selected assignment markers without inventing a wire path.
- `lib/geometry.ts`: bounded mask/region contracts and failure explanations.
- `components/results-panel.tsx`: counts, scores, uncertainty, and inspection.
- `lib/vision.ts`: validated public response contract and display metadata.
- `lib/breadboards.ts`: bounded board grouping evidence, source and geometry validation.
- `components/breadboard-regions.tsx`: unresolved board-region inspection and overlays, separate from physical-board counts.
- `lib/server/vision-proxy.ts`: bounded server-side forwarding and safe errors.
- `app/api/vision/analyze/route.ts`: HTTP entry point.
- `app/manifest.ts`: PWA manifest.

## AI endpoint localization and review — Step B.2

After calibrating the boards (including rail lanes), select a segmented wire and
choose **Propose endpoints with Muse**. This explicitly sends the photograph and
selected and neighboring masks to `POST /api/vision/endpoints`; it is an additional model request.
Muse returns original-image pixels and visual evidence, never authoritative board
or hole IDs. Praxis uses the same bounded Step A resolver as manual assignment.
Ambiguous cross-board matches, background and unregistered rails remain unknown.

Review A and B independently:

- **Confirm** accepts a visible-insertion proposal and its calibrated hole.
  Junction-only, mask-tip, occluded and insufficient evidence cannot be confirmed
  or automatically snapped, even when their reference pixels coincide with a hole.
- **Correct** opens the existing image/pixel picker. The new location is a preview
  until **Confirm correction**. Cancel keeps the previous reviewed value.
- **Unknown** clears the final location while retaining the rejected suggestion.
- **Save reviewed assignment** requires both endpoints to be reviewed. One or both
  may be unknown; these records remain incomplete. Two endpoints in the same
  physical hole are flagged and cannot be saved until corrected or marked unknown.

Dashed amber markers show proposals; green markers show reviewed positions;
question marks show rejected/unknown positions when a source pixel exists. A
purple dashed marker shows a pending correction. Corrections retain a faint marker
at the original proposal. No line is drawn between endpoints.
Gray dashed squares mark visible connector junctions as references only. These are
separate from insertion points and never resolve to holes.

### Wire-specific visual grounding and insertion visibility

The backend creates a deterministic copy of the photograph using the selected
SAM mask: original wire pixels are highlighted in cyan, neighboring wire masks
are darkened, and the background is dimmed/desaturated. At mask crossings the
selected wire takes precedence. The reference keeps the original image size and
coordinate system, with no cropping or resizing. It is generated with Sharp from
validated geometry; no image-generation model invents scene content.

Muse receives **both the original photograph and this aligned visual reference**.
The SVG path is no longer placed in the reasoning prompt as text. The original
photograph remains the evidence source; the highlight only identifies the selected
candidate and cannot reveal an occluded hole or prove wire identity.

`proposedImagePosition` now means the actual physical insertion point only.
`connectorJunctionPosition` separately records a visible wire-to-connector junction.
New responses distinguish `visible_insertion`, `visible_connector_junction`,
`occluded_insertion` and `insufficient`. Every non-visible insertion must have a
null proposed insertion position. A connector body hiding its pin means an
**unknown hole**, even when the visible junction is close to a calibrated hole.
Legacy connector/mask-tip evidence is also prevented from snapping on the client.
The user can retain these original references, mark both endpoints unknown and
save an incomplete review. This is a valid abstention, not an accurate hole prediction.

### Endpoint latency

The endpoint panel shows a live client elapsed clock and **Cancel endpoint request**.
After success or failure it retains the total duration and, when supplied by the
backend, image preparation, `wire.grounding`, and `muse.endpoints` times plus the
request ID. Timings stay associated with their image, analysis and selected wire.
Cancellation stops the clock; stale/late results cannot populate another wire.
Successful proposal snapshots also retain client elapsed time and backend diagnostics
for later inspection alongside the original proposals.

The client total includes upload/proxy/response overhead. Backend and Muse times
are nested measurements, not durations to add together; Muse request time includes
network transfer and provider waiting, not just model computation. Initial image
analysis is separate and is not included in this endpoint timer. Unknown stage
durations are omitted rather than shown as measured zeroes.

Endpoint inference uses one attempt without automatic retries, under the configured
provider deadline. Initial Muse interpretation also uses one attempt; SAM retries remain configurable. The two-image
input may increase model latency; improved speed or accuracy must be measured in a
live comparison rather than inferred from local tests. Restart both services (and
rebuild compiled deployments) before evaluating this updated response contract.

For evaluation, compare exact resolved holes against independently reviewed **visible**
insertions, record unknown/occluded endpoints separately, and measure both client
total and Muse duration. A correct abstention for an occluded insertion must not be
counted as a correct hole prediction. The same photo, wire selection and calibration
should be retained when comparing versions.

Saved reviews can be reopened. Review drafts and pending corrections survive wire
switching during this photograph's session. JSON inspection retains the original
proposal, selected candidate and analysis IDs, model, calibration revisions,
reviewed values, and per-endpoint source (`ai_user_confirmed`, `manual_correction`,
`user_unknown`). This extends the existing assignment records; no second graph or
connection system is created. Identity remains unverified and contact unknown.

Staleness is derived; it never replaces the historical review decision. Reanalysis,
board/rail revision changes or removal prevent saving and hide the old markers.
Proposals snapshot every calibrated board searched, so changing any searched board
or adding a board also invalidates the proposal: a formerly unique match may have
become ambiguous. Existing manual-only records retain their narrower per-endpoint
invalidation behavior. Late responses after selection, analysis, calibration,
a newer request or manual editing are discarded. AI never automatically replaces
an existing assignment. Stale records remain inspectable.

Storage remains in photograph-local component memory, capped at 100 assignments.
Reviewer assignments have no database or browser persistence: replacing the photograph or reloading
clears assignments and reviews.

Run the repeatable browser regression with the supplied `Complete-Circuit-5.jpg`
in the repository root:

```sh
npx playwright install chromium
npm run test:e2e
# Or use an already installed Chrome:
PLAYWRIGHT_CHROME_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' npm run test:e2e
```

These tests use the real photograph with mocked perception and endpoint replies.
They verify workflow and provenance, not live model accuracy or confirmed manual
ground truth. Live Muse/SAM comparison is a separate, explicitly requested upload.

## Controlled endpoint evaluation and calibration diagnosis

The first three experimental phases are implemented without changing the strict
snap policy (`0.32` pitches, ambiguity margin `0.12`) or fitting a new homography.
Hole rankings are separate from grid acceptance, user review, and electrical contact.

### Frozen original replay

```sh
npm run benchmark:replay
```

This offline command replays the ten original Muse points from the supplied
benchmark. It must reproduce **7/10 exact endpoints, 2/5 complete wires, 0 wrong
holes and 3 unresolved endpoints**. It includes the two nearest holes, image-pixel
and normalized-pitch distances, ambiguity margins and rejection reasons.
The fixture preserves the original proposal/review records, calibration revision,
full calibration, policy, source resolver and image/report hashes. Unit tests pin
its bytes. Manual corrections are not used as original predictions. A/B reversal
is allowed within a wire; board ID and logical hole must match exactly.

New proposals retain these resolver diagnostics in their provenance and saved
assignment JSON. Expand **Inspect hole ranking and rejection diagnostics** for an
endpoint. Ranked holes are inspection data, not clickable or accepted suggestions.
A spatial-consistency warning flags points far from the selected mask, coincident
points, or an endpoint pair concentrated in one region of a long candidate. This
is a soft check: exposed leads may extend beyond a SAM insulation mask and looped
wires may legitimately have nearby ends. It never invents or verifies a connection.

The root contains the benchmark photograph and report, but the report does not
archive the original SAM masks. The frozen fixture records that absence explicitly.
Resolver replay is reproducible; refinement of that exact original run cannot be
reproduced until those masks are recovered. Rerunning SAM would create a different
experiment and must not be substituted into the frozen baseline.

### Independent calibration validation

1. Confirm a board calibration, then choose **Start blinded calibration check**.
2. Detection, projected-grid and endpoint overlays disappear. Choose an additional
   printed terminal-hole label such as `b12`, then click the physical center or
   enter **Checkpoint X/Y**. These original-image marks are never snapped.
3. Collect additional marks across both strips and the beginning/middle/end of the
   board. The four fit anchors are rejected as validation checkpoints. Avoid holes
   already used for endpoint corrections; do not copy model or projected positions.
4. Choose **Finish blinded calibration check** to reveal signed observed-minus-
   projected residuals, mean shift, RMS, median, P95, maximum and regional summaries.
   Residuals remain hidden during collection, including previous audit reports.
5. Inspect directional/region patterns before deciding whether calibration needs
   correction. The tool does not automatically label the cause, refit calibration,
   move anchors, re-snap observations or change calibration revisions.

Audit records remain tied to photograph, board, revision and a calibration snapshot.
Recalibration/removal makes old reports visibly stale. They are retained for
inspection. Measurements are session-local; export before reloading.

### Opt-in local pixel refinement

Expand **Local pixel refinement experiment** for an endpoint and choose
**Experimentally refine endpoint A/B**. This runs locally on a small patch from the
original photograph and the selected SAM mask, without another Muse call.
The first implementation examines foreground/background color contrast, the
mask-supported foreground component, local elongation and terminal direction.
It rejects missing support, low contrast, ambiguous shapes/directions, truncated
patch endpoints and excessive displacement. It does not consult ground-truth hole
IDs or select the nearest hole to manufacture a successful refinement.

A supported output is an **experimental wire-tip boundary**, not proof of insertion.
A magenta diamond marks its pixels. The original Muse point, method/version,
evidence measurements, displacement, execution time, refined coordinates and strict
resolver diagnostics are preserved separately. The experiment never overwrites
`originalProposal`, changes a review decision, commits a correction or creates an
assignment. It is disabled for occluded, connector-only and insufficient evidence.
The normal confirm/correct/unknown workflow remains authoritative for user review;
wire identity and electrical contact remain unverified.

This color-based experiment can miss bare metal leads or fail under challenging
lighting, thin masks, branching or crossings. It has not been validated as an
accuracy improvement on unfamiliar real photographs and is not enabled automatically.
Reviewable one-click hole suggestions and endpoint-crop model experiments remain
later phases.

### Archive complete inputs and evaluate unfamiliar photographs

**Export evaluation bundle** downloads image metadata/SHA-256, full analysis with
SAM masks, calibration snapshots/revisions, original proposals and timings, review
records, refinement experiments and independent calibration audits. Save the
original photograph separately; the JSON does not embed or upload its bytes.

Record a separate blinded truth file **before endpoint inference**, for example:

`bundle.json` and `truth.json` are example filenames; this command does not create
them. Relative paths are resolved from the directory where you run the command
(normally `praxis-frontend`). In particular:

- **Bundle:** click **Export evaluation bundle** in Praxis. The browser normally
  saves `praxis-evaluation-bundle.json` (or a numbered copy) in Downloads. Use the
  actual export containing all wire proposals; an export taken before requesting
  endpoints has no proposals to evaluate.
- **Truth:** create a separate JSON using the schema below and your pre-recorded
  physical hole labels. Copy `imageSha256` and `analysisRunId` from that bundle's
  `image.sha256` and `analysisRunId`. These identify the inputs, not the answers.
  Do not fill in hole labels from model predictions or corrected assignments.
- **Photograph:** use its real path. A photo at the repository root is
  `../jumper_wires_breadboard.png` when running inside `praxis-frontend`.

Save the JSON below to an actual file such as `benchmarks/my-run/truth.json`,
replacing its placeholder metadata and illustrative hole labels with your data.

```json
{
  "imageSha256": "<64-character SHA-256 of the original photograph>",
  "analysisRunId": "<the analysis run ID from the bundle>",
  "recordedBeforeInference": true,
  "wires": [
    { "id": "jumper_wire_1", "boardId": "board_1", "holes": ["b12", "e14"] }
  ]
}
```

Then, with both applications' dependencies installed:

```sh
npm run benchmark:refine -- bundle.json truth.json original-photo.png
```

The offline runner checks image hashes, analysis identity and calibration revisions,
requires archived original masks, and compares raw versus experimental refined
endpoint yield, unresolved/wrong-hole counts, resolved precision and complete-wire
yield. Raw strict matches are preserved; only unresolved visible-insertion points
are attempted. Unsupported refinements remain unresolved. Correction records do
not become input predictions, and truth is not passed to the refinement algorithm.
The output records input hashes and experiment policy. Node uses the backend's Sharp
decoder while the browser uses canvas; small rasterization/color differences are
possible, so archive the implementation/environment for comparisons.

### Controlled refinement of every endpoint

To evaluate regressions in already-resolved predictions as well as unresolved
ones, use the same offline runner with `--all-endpoints`:

The following command assumes you already saved the two JSON input files in the
current directory. Otherwise replace each example filename with its actual path.

```sh
npm run benchmark:refine -- \
  bundle.json \
  truth.json \
  jumper_wires_breadboard.png \
  --all-endpoints
```

This attempts the unchanged color-tip algorithm at **every original visible-insertion
coordinate**, including strict matches. It reconstructs the selected SAM masks
from the bundle and applies the same calibration and snap policy to both results.
It does not read corrected/reviewed positions as predictions or write to the inputs.
Null or non-visible-insertion proposals remain explicit skips and unresolved
endpoints in the denominator. The number of wires/endpoints is taken from the
recorded truth, rather than assuming five wires or a particular baseline score.

Unlike the default unresolved-only mode, a rejected refinement in this experiment
is reported as unresolved **without falling back to an originally correct point**.
This deliberately exposes correct-to-unresolved regressions. Rejected experiments
retain their algorithm result/reason, and every endpoint's original/refined pixels,
resolved hole, correctness, coordinate error and transition appear in the report.
The original bundle, original predictions and frozen baseline remain unchanged.

The JSON and terminal table include correct endpoints, wrong-hole assignments,
unresolved endpoints, complete wires, correct→wrong, correct→unresolved, and
unresolved→correct transitions. A/B truth correspondence may reverse, but it is
chosen once from the raw observations and held fixed during comparison, so the
refined results cannot be relabelled to conceal regressions.

For independently measured localization error, optionally include raw original-image
hole-center positions in each truth entry, **in the same order as `holes`**:

```json
{
  "id": "jumper_wire_1",
  "boardId": "board_1",
  "holes": ["b12", "e14"],
  "positions": [
    { "x": 428, "y": 612 },
    { "x": 886, "y": 538 }
  ]
}
```

These coordinates are illustrative, not measured truth. Record the actual centers
independently before inference. Without `positions`, error is measured against the
calibration-projected centers of the labelled truth holes and is explicitly marked
**calibration-projected**, not independently measured physical localization error.
Reference basis is retained per endpoint, with totals for each basis.
Reports include error count, mean, RMS, median, P95 and maximum, plus paired-point
error improvement/worsening counts. Raw and refined means may cover different
populations if refinement rejects points; paired means expose the comparable subset.

The dataset acceptance check requires all-endpoint mode, zero refined wrong-hole
assignments, no originally correct endpoint becoming wrong/unresolved, and either
more correct strict resolutions or lower mean paired localization error. Error-only
acceptance requires every raw-coordinate observation to have a comparable refined
coordinate, preventing removal of hard points from manufacturing an improvement.
The reported `1e-6` pixel epsilon only filters floating-point noise; it is not a
claim of statistically or physically significant improvement. Passing this one
dataset makes the experiment eligible for held-out validation, never automatic
global enablement. A failed check recommends keeping refinement opt-in.

By default, JSON is written to stdout and the human summary to stderr. To save a
JSON artifact while showing the terminal summary, use a new output filename:

```sh
npm run benchmark:refine -- bundle.json truth.json jumper_wires_breadboard.png \
  --all-endpoints --output refinement-all-report.json
```

Existing files are never overwritten. The report records input hashes, source
hashes, mode, runtime/decoder versions and both policies. All processing stays
offline; this adds no Muse/SAM request, browser workflow change or global refinement
activation. Without `--all-endpoints`, the existing unresolved-only behavior remains.

Keep separate evaluation bundles for held-out photographs and repeat inference
runs. Never rewrite the frozen fixture, tune to pass its ten points, infer improved
precision from synthetic tests, or count a correct abstention as an exact hole.

## Wire coverage and recovery

After saved SAM segmentation, the workspace exposes **Wire coverage and recovery**.
New combined jobs audit locally before initial Muse interpretation. Reconnect an
older saved analysis and click **Audit wire coverage** to inspect it without any
SAM/Muse call. Calibration and existing endpoint reviews are separate from this panel.

1. Inspect rejection reasons and unexplained pink trace hypotheses. Select a candidate
   to see its observed amber mask. Passing geometry checks does not verify identity.
2. **Recover continuations and missing wires** explicitly requests bounded native-resolution
   SAM crops. Observed crop-edge continuations and local short-wire traces receive
   alternating priority before broad tiles. It does not send every tile. Requests, crop pixels,
   rounds, stop reasons, and truncation are visible. A failed crop preserves earlier
   evidence and consumes its budget; timeout does not prove upstream work stopped.
   **Crop inspection outcomes** distinguishes successful inspections from failed,
   timed-out, interrupted, and legacy unknown attempts. Previously attempted crop-and-prompt requests
   remain blocked from automatic redispatch, and budgets are not refunded. Different spatial
   targets within the same crop remain eligible; up to three independent objects
   share one SAM request, with per-object seed validation. Legacy visited regions
   with unknown prompts remain blocked conservatively. A `blocked regions`
   result means uninspected regions remain, not that coverage is complete.
3. Select a candidate with a mask and choose **Ask Muse to verify candidate** for one
   focused photo/mask/context request. Multiple wires, fragments, hidden insertions,
   and uncertainty remain explicit. Muse results cannot create human review decisions.
4. Select up to eight candidates to review one physical identity as verified, rejected,
   or uncertain, with an evidence note. Fragment grouping is a human hypothesis;
   it never creates a bridge, hole assignment, or electrical connection. Re-audit
   after review to update verified coverage.
5. **Interpret recovered candidates** is a separate explicit Muse request for the
   derived checkpoint. Original SAM and historical Muse predictions stay preserved;
   this action can change the displayed interpretation, so export browser reviews
   before changing analysis revisions.

Native recovery IDs refer to raw checkpoint evidence and may differ from numbered
objects in the main interpretation. Identity decisions are tied to the report's
snapshot. On new checkpoints, only uniquely matching unchanged image/mask or trace
fingerprints without new conflicts carry their original review provenance. The UI
labels carried reviews and groups needing re-review; changed groups do not count
as verified coverage. An explicit current decision overrides carried context.
Same-report empty crops preserve reviews. Candidate coverage uses the
existing strict geometry checks; verified coverage uses human decisions only. The
classical trace pass is experimental, can detect printed rails/component edges,
and has bounded output. Its counts do not measure physical wire recall.

In **Wire endpoints**, the optional **Focused crop + calibrated grid reference
(experiment)** input sends aligned candidate photo/mask crops plus context and a
separate artificial calibrated grid. Returned crop pixels are mapped back to the
original photograph before the unchanged snap policy. Original crop coordinates
and frame metadata are preserved in endpoint proposals and evaluation bundles.
The grid and model confidence never override obscured physical evidence; unknown
insertion points stay unknown. Full-image input remains the default.

For reproducible offline coverage overlays and independent wire/endpoint acceptance
scoring, see [backend benchmark instructions](../praxis-backend/README.md#offline-coverage-and-acceptance-benchmarks).
These commands use real exported snapshot paths rather than placeholder bundle files.
No accuracy target is claimed achieved by implementation or synthetic tests.

### Short-wire and endpoint grounding experiments

In **Wire coverage and recovery**, choose **Find short wires automatically** for a
bounded native-resolution scan and spatially prompted SAM recovery. Current crop
budgets remain in force. To target a known missing wire, enable **Mark a missing wire
body**, click its visible body in the photograph, then **Recover marked wire (user
assisted)**. Manual-seed gains are recorded separately from automatic recovery.
After calibration, **Use calibration for short-wire search** shares hole centers
as search priors; share again after recalibration. Hole spacing may also be entered
as a search scale. Dark components, printed markings and shadows remain possible
false candidates and require identity review.

Truncated masks explicitly say **Truncated at crop boundary**. They remain fragment
hypotheses; their clipped tips cannot become insertion proposals. Associations show
supporting signals in diagnostics and remain separate masks with no inferred bridge.
The original photograph boundary and crop boundary are reported separately.

The existing focused crop/grid checkbox remains opt-in. **Insertion close-ups (one
extra request; experiment)** adds one bounded localization call after focused wire
identification, sending both endpoint regions together. **Normalized coordinate
contract (experiment)** independently tests model output in a 0–1000 coordinate
frame. All primary coordinates are transformed back to original pixels before the
unchanged resolver. The review panel and exported proposal preserve coarse and revised
coordinates, crop frames, status and coordinate contract. Failed localization leaves
insertion unknown; it never quietly falls back to a coarse point for acceptance.

For paired full/focused/close-up experiments and one-versus-two request concurrency,
use the [controlled benchmark commands](../praxis-backend/README.md#controlled-endpoint-grounding-comparison).
The live runner requires a real exported bundle and an existing inactive saved job;
it makes model calls. `benchmark:grounding` is the separate offline scorer. Neither
command modifies original evidence, calibration, review decisions or predictions.

Close-up outcomes are reported per endpoint: visible insertion proposed, model
abstention, no anchor (skipped), crop fragment (blocked), failed, or timed out. The
review panel shows the preserved coarse coordinates separately; failure never
silently restores them for assignment. Exports retain both stages and their status.

`benchmark:grounding` now writes `grounding-comparison-v2` and accepts both v1 and v2
experiment reports. The frozen baseline, same-run coarse score, and final operational
score are separate. All truth endpoints stay in the operational denominator,
including failed/missing requests, skipped crops and model abstentions. A failed
close-up can therefore reduce operational yield without being mislabeled as a model
abstention. `coarse.availableEndpoints` identifies where an actual coarse response
was recorded; a blocked fragment supplies none. `completedLocalization` is a
conditional score with its own explicit denominator, not overall accuracy. Regression
counts identify unavailable results, abstentions, skipped crops and strict snap
rejections separately, against both frozen and same-run coarse predictions.
`refinementNoRegression` explicitly checks for damage to same-run coarse results;
the interim acceptance gate requires both regression checks. Paired pixel errors also compare same-run coarse and final
points only where both exist, reporting that pair count. Transport request outcomes
remain separate from validated localization and ground-truth correctness. Older
reports without transport diagnostics report that evidence as unavailable.

Recovery interpretation now preserves earlier selectable mask evidence within the
same photograph and SAM checkpoint lineage. The results panel reports matched,
retained, new, and historically restored masks. Retained masks stay selectable and
show **Retained earlier mask** and **Review conflicting evidence**. Unchanged masks
keep their selectable IDs; a different geometry is a separate hypothesis. Mask
counts must still be audited against physical-wire ground truth.

Exports retain `selectionEvidence` per wire and a `provenance.wireSelection`
summary, including source snapshot/attempt references and budget-deferred raw
object IDs. Earlier successful saved attempts can restore already-lost masks on the
next successful interpretation, with new IDs for restored hypotheses and stable IDs
for currently selectable wires. Original model outputs remain in backend attempt
evidence. This does not add model calls or modify older exported bundles. Review
warnings persist as historical conflict evidence; current human identity reviews
remain separate. New interpretation revisions still make earlier endpoint reviews
stale. Truncated masks still cannot supply physical insertion points, and strict
hole snapping and unknown results are unchanged.

See [candidate-preservation replay and limits](../praxis-backend/README.md#preserve-selectable-wire-evidence-across-interpretation)
for the supplied Phase 3 regression fixture and its distinction between selectable
hypotheses and physical-wire coverage.

Recovery checkpoints now update the main selectable-mask view locally, without
waiting for full-scene Muse interpretation. On an existing saved job, click **Audit
wire coverage** to publish geometry from the latest saved recovery checkpoint without
another SAM/Muse call or additional crop budget. New masks remain SAM candidates and can
be used for calibration and manual endpoint review. If Muse is running, **Continue
with SAM candidates** also works for a mixed view containing earlier interpretation
and newer unverified geometry. The status distinguishes geometry availability from
successful interpretation. A timeout retains the latest candidate view.

`provenance.candidateLayer` binds the view to its source snapshot/hash and attempt.
New checkpoint revisions stale earlier endpoint reviews while preserving mask IDs.
Geometry acceptance, wire identity, insertion evidence and electrical contact remain
separate. Publication budget failures are shown explicitly; raw checkpoint evidence
is still saved. Original scene results and predictions are not replaced by local
observations.

**Benchmark build provenance** shows the frontend and current backend fingerprints
and the producer of the saved result. Exported bundles include those identities,
algorithm versions and per-endpoint producer fingerprints. Older records without a
producer fingerprint remain explicitly unversioned. Frontend development fingerprints
identify code at server start: restart development servers after edits before a
controlled benchmark so HMR does not leave a stale session fingerprint.

The backend [focused interpretation experiment](../praxis-backend/README.md#focused-interpretation-experiments-and-diagnostics)
compares scene variants and opt-in identity-only crops on one pinned checkpoint.
It saves each focused check independently, enforces a total budget across the
checks, and stops after an unknown upstream outcome. Model request success is not
physical-wire accuracy. For endpoints, keep the existing full/focused/two-stage
comparison separate, using the same photograph, frozen calibration and blinded
truth; run `benchmark:grounding` on the resulting evidence. No default grounding mode
or snap threshold changed.

Endpoint review now labels unsupported evidence as **Original Muse evidence** and
shows a corrected/confirmed result separately. Endpoint sources are recorded per
endpoint rather than labeling every position as user-selected. Close-up diagnostics
accept all input frames, including the seven-image two-endpoint/grid case.

### Continuation recovery and the next benchmark

Restart both servers after this change, reconnect the saved analysis, and **Audit wire
coverage** first (no model call). **Recover continuations and missing wires** then
uses the cached masks to anchor larger native-resolution crops. The original fragment
and its stable selectable ID remain preserved. A longer, geometrically valid mask with
at least 95% shared native fragment pixels, 15% size growth, and observed pixels beyond
the old crop can survive duplicate filtering as a separate hypothesis. These are
conservative observation checks, not identity confidence or measured recall. Unsupported
unions, inferred bridges, and crop exits are never promoted into insertions. Crop-boundary
endpoint blocking still applies to any mask that remains truncated. Missing audit
previews do not block recovery from raw masks; new seed-validated masks receive priority
within the existing decode and preview limits.

Under **Reviewable mask extensions and fragment associations**, choose **Compare both
masks for review**. Inspect both overlays, then explicitly record the identity decision.
The longer mask gets its own selectable evidence ID, not an automatic replacement for
the old wire. Review IDs are native checkpoint IDs and may differ from the main numbered
list. New overlapping evidence requires re-review; earlier endpoint reviews remain tied
to their original analysis revision. Mask count can increase without physical-wire recall
increasing. Count an upgraded upper wire once in the 17-wire inventory.

Automatic short-wire discovery samples across the breadboard, component clusters,
calibrated grid priors and unexplained traces, instead of examining only the first twelve
windows. It decodes the source once, limits local inspection to 64 windows / 12 million
crop pixels, and proposes at most 16 targets. Existing mask **pixels**, rather than an
entire bounding box, determine coverage. Dark traces remain unverified because shadows,
rails and components can look similar. Human seeds are recorded separately and excluded
from claims of fully automatic recovery.

The existing cumulative SAM request, round and pixel limits still apply; old failed
attempts are not refunded. If the saved analysis has exhausted its budget, raise the
explicit backend limits for a separately recorded run as described in the backend README.
Recovery publishes candidates locally without waiting for scene interpretation. Do not
repeat scene interpretation to make the new masks selectable.

Freeze the original bundle, calibration and the 17-wire inventory before evaluating the
new checkpoint. Compare full-image against **Focused crop + calibrated grid reference**
using the same eligible wires, then score with `benchmark:grounding`. Keep all ten planned
endpoints in the denominator, including missing masks, blocked fragments, provider failures
and abstentions. Report complete wires, wrong accepted holes, request count and wall time.
Color-tip refinement stays opt-in: four rejected attempts provide no evidence of a gain.

The interim gate remains 15/17 distinct selectable physical wires, 8/10 correct endpoints,
4/5 complete wires, zero wrong accepted holes and under 75 seconds for the five-wire batch.
Retain every originally correct endpoint when comparing the same wires. A two-request
concurrency cap alone does not guarantee that latency. Annotate identities independently,
track duplicates/fragments separately, and repeat on a held-out photograph before claiming
reliability. No benchmark improvement is inferred from synthetic test passes.

### Reviewing quarantine, uncertain continuations and retries

After restarting the servers, use **Audit wire coverage** on the saved analysis. The
new audit policy reconciles earlier review context. **Quarantined raw observations**
shows prompt mismatches and capacity exclusions preserved in checkpoints. They cannot
count as covered wires, suppress a fresh matching mask, or enter the selectable set.
Raw retention is independently bounded, and `raw evidence budget` is a stopping reason,
not a coverage success.

**Continuation planning decisions** distinguishes supported and uncertain topology,
missing safe anchors, ambiguous boundary components and exhausted allowances. A
truncated mask can now receive another observation even when its skeleton has extra
ends or branches. Uncertain recovery uses one anchor from one observed connected
component and defaults to one normal request per analysis within the existing total
budgets. Mask acceptance and exact-hole snapping remain unchanged.

In **Crop inspection outcomes**, a failed, timed-out or interrupted request can expose
**Retry this crop**. Enter a reason. When upstream completion is unknown, explicitly
check the authorization acknowledging that the original request may still be running.
The retry creates a separate recorded attempt and consumes another request, pixels and
round. Original outcomes remain visible; one retry per work item is permitted. A saved
analysis with exhausted budgets requires explicitly larger backend limits before another
request. Legacy unknown records without reproducible prompts and successful inspections
cannot be retried through this control. There is no automatic retry or timer that clears
upstream uncertainty.

Under an extension proposal, **Ask Muse to verify extension** compares the original
photograph and both observed masks. It reports continuity, nearby wires, crossings and
component leads. A favorable result appears as model evidence; the human-verified count
and electrical connection status stay unchanged. Record human identity decisions
separately, retain `unknown` for unsupported insertions, and evaluate all ten planned
endpoints against the frozen benchmark. No new accuracy claim follows from these checks.
