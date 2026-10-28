# Praxis — vision workspace

A mobile-friendly Next.js interface for Praxis's first perception milestone.
Upload a photograph, send it to the backend, and inspect the returned breadboards,
LEDs, resistors, and jumper wires directly over the image.

## Run locally

Use Node.js 22.12 or later and install the frontend dependencies with `npm ci`.

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

Calibration, selections and photographs stay in component memory. Replacing or
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

Photographs and results stay in component memory. Blob preview URLs are revoked
on replacement/removal, no photographs are written to disk or browser storage,
and responses are marked `no-store`. An analyzed photograph is sent to the backend
and Meta, subject to the provider's account terms. Cancellation stops the browser
request; propagation to upstream work depends on the hosting runtime.

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
provider deadline. The main image-analysis retry policy is unchanged. The two-image
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
There is no database or browser persistence: replacing the photograph or reloading
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
