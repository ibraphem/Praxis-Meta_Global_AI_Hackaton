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
Browser QA should also exercise upload, analysis,
selection, empty scenes, errors, and the mobile layout.

For a compiled local server, run `npm start` after building. It also uses port 3001.

## Code map

- `components/vision-workspace.tsx`: upload, preview lifecycle, cancellation, and requests.
- `components/image-preview.tsx`: image-relative component overlays.
- `components/wire-overlays.tsx`: mask selection and separately labeled search regions.
- `lib/geometry.ts`: bounded mask/region contracts and failure explanations.
- `components/results-panel.tsx`: counts, scores, uncertainty, and inspection.
- `lib/vision.ts`: validated public response contract and display metadata.
- `lib/server/vision-proxy.ts`: bounded server-side forwarding and safe errors.
- `app/api/vision/analyze/route.ts`: HTTP entry point.
- `app/manifest.ts`: PWA manifest.
