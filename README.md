# Praxis

Praxis turns a photograph of a breadboard circuit into a reviewable electrical
connection graph. It combines browser-side computer vision with Meta's SAM and
Muse models, keeps uncertain evidence explicit, and can recommend a single safe
wiring correction for a reviewed circuit.

## What it does

1. Captures or uploads a circuit photograph.
2. Calibrates the breadboard lattice with OpenCV.js.
3. Segments visible conductors and components with SAM 3.1.
4. Identifies components and printed labels with Muse.
5. Maps visible endpoints to calibrated terminal holes.
6. Preselects supported proposals and leaves uncertain contacts unresolved.
7. Builds an observed connection graph after review.
8. Infers circuit intent, diagnoses a fault and proposes a safe lead move.
9. Verifies the physical repair from a fresh photograph.

Praxis does not treat model output as proof of electrical contact, polarity,
continuity or safe operation. Ambiguous and hidden contacts remain unresolved.

## Repository structure

```text
praxis-frontend/   Next.js application, OpenCV.js worker and review UI
praxis-backend/    Fastify API, Meta model integration and persisted jobs
docs/              Camera, inspection and validation guides
benchmark-evidence/ Local benchmark artifacts (gitignored)
```

The primary experience is available at `/camera`. The older photograph
workspace remains available at `/workspace`.

## Requirements

- Node.js 22.13 or newer
- npm
- A Meta Model API key with access to `sam-3.1` and `muse-spark-1.3`
- A circuit photograph you own or have permission to submit

## Setup

Install and configure the backend:

```sh
cd praxis-backend/server
npm ci
cp .env.example .env
```

Set `META_API_KEY` in `praxis-backend/server/.env`. Never expose this key to the
browser or commit the `.env` file.

Start the backend:

```sh
npm run dev
```

In a second terminal, install and start the frontend:

```sh
cd praxis-frontend
npm ci
npm run dev
```

Open [http://127.0.0.1:3001](http://127.0.0.1:3001). The backend listens on
`http://127.0.0.1:3000` by default.

For phone-camera testing over a local network, follow
[docs/camera-demo.md](docs/camera-demo.md). Camera access requires HTTPS outside
localhost.

## Environment

Backend configuration is documented in
[`praxis-backend/server/.env.example`](praxis-backend/server/.env.example).
Important values include:

| Variable               | Purpose                                      |
| ---------------------- | -------------------------------------------- |
| `META_API_KEY`         | Private Meta API credential                  |
| `META_SAM_MODEL`       | Segmentation model; defaults to `sam-3.1`    |
| `META_REASONING_MODEL` | Semantic model; defaults to `muse-spark-1.3` |
| `PRAXIS_API_TOKEN`     | Optional private frontend-to-backend token   |
| `ANALYSIS_JOB_DIR`     | Private persisted job directory              |

Frontend server configuration is documented in
[`praxis-frontend/.env.example`](praxis-frontend/.env.example). Do not use
`NEXT_PUBLIC_` variables for secrets.

## Validation

Run backend checks:

```sh
cd praxis-backend/server
npm run typecheck
npm test
npm run build
```

Run frontend checks:

```sh
cd praxis-frontend
npm run typecheck
npm run lint
npm test
npm run test:e2e
npm run build
```

Live inspection tests submit photographs to the configured Meta provider and
are intentionally separate from the mocked automated test suite.

## Documentation

- [Automatic circuit inspection](docs/automatic-circuit-inspection.md)
- [Camera demo setup](docs/camera-demo.md)
- [Camera demo validation](docs/camera-demo-validation.md)
- [Frontend details](praxis-frontend/README.md)
- [Backend details](praxis-backend/README.md)

## Security and evidence

- Meta credentials stay in the backend.
- Uploads are size- and pixel-bounded.
- Persisted jobs and benchmark evidence are gitignored by default.
- Model responses are validated before reaching the browser.
- Reviews preserve unresolved evidence rather than silently inventing contact.

Disconnect power before changing physical wiring. A photograph cannot prove
voltage, polarity, continuity or that a circuit is safe to energize.
