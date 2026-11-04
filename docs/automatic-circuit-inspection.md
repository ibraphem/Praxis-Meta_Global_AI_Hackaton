# Automatic circuit inspection

The home page and `/camera` now use a general photo-based inspection workflow.
There is no supplied two-LED schematic, fixed component count, expected netlist,
or photo-specific hole coordinate in this workflow. The earlier fixed-camera
session endpoints remain available for compatibility; they are not used by these pages.

## Use it

1. Start the backend and frontend with their existing environment configuration.
2. Open `/camera` (HTTPS is required for camera access from a phone).
3. Capture a clear overhead frame or upload a JPEG, PNG or WebP under 8 MB.
4. Select **Analyze circuit**. The photograph and focused component crops are sent
   to the configured Meta reasoning model. This is external AI processing.
5. Review the proposed hole grid and confirm the board's terminal-strip layout.
   If needed, open **Adjust grid landmarks**, place labelled hole centres on the
   image, and fit the adjusted grid. Re-fitting clears confirmations.
6. Review each component's identity, terminal locations, and proposed connections.
   Confirm supported contacts individually. Wire identity/continuity and component
   electrical roles have separate confirmations. Reject false detections or add
   missing components/terminals. Leave hidden contacts unresolved.
7. Enter a reviewer name and select **Save review and build graph**. The graph is
   calculated from those reviewed records. Download the inspection to keep its
   proposals, review history and connection data.

The latest inspection is restored on the same browser. Polling, reload, grid fitting,
human review, graph construction and evidence export make no provider requests.
New photo analysis is an explicit user action. There are no automatic inference retries.

## How automation works

- One structured vision request inventories up to 24 components and up to two
  supported boards. These are processing limits, not expected circuit contents.
- The model locates visible, labelled hole centres across both terminal banks.
  A least-squares homography fits their positions to the physical breadboard grid.
  A local grayscale search refines the proposed hole centres. Inconsistent or
  geometrically degenerate fits are rejected rather than silently accepted.
- One structured request per detected component inspects an unannotated crop with
  full-scene context. Crop coordinates are transformed back to the original image.
- Visible insertion positions are matched to holes using the existing geometric
  distance/ambiguity policy. Nearness alone never confirms contact.
- AI claims remain unresolved until a human explicitly confirms them. Hidden
  contacts have null positions. Power-module internal wiring, switch contact pairs,
  LED polarity and rail continuity are not fabricated.
- The existing connectivity engine calculates nets. Devices retain separate ports;
  an LED, resistor, power module or switch assembly is never treated as a wire.

## Scope and validation

The supported grid model is currently the standard ten-column, 30- or 63-row
breadboard. This is a declared physical board template, not a hardcoded circuit.
Unsupported layouts and insufficiently visible labels need another photo or human
grid input. Rail continuity must be explicitly declared; its printed colour is
not proof. A photograph does not establish internal module circuitry, reliable
electrical contact or actual circuit operation.

The inspection deadline is `CIRCUIT_INSPECTION_TIMEOUT_MS` (default 300 seconds).
Each request uses `CIRCUIT_INSPECTION_REQUEST_TIMEOUT_MS` (default 90 seconds), capped
by the global `PROVIDER_TIMEOUT_MS`. Set the global provider limit to at least
90000 to allow that full request window. Other vision workflows retain their
existing timeouts. The model admission reservation lasts for the entire inspection.
Requests run at the configured
Muse concurrency, without retries. Partial proposals survive a deadline. Restarted
inference becomes interrupted and is not replayed.

Inspections, orientation-corrected images and review revisions are persisted in
the private job SQLite database. `MAX_STORED_JOBS` and `JOB_RETENTION_HOURS` also
bound this inspection store. Inactive inspections can be deleted from the UI.

Tests use synthetic images and mocked model responses. They check geometry,
coordinate mapping, unresolved contacts, review prerequisites, stale revisions,
restart recovery, the private API proxy, and the browser review flow. These checks
do not establish detection accuracy on real circuit photographs.

An exploratory live test on the supplied circuit photograph made 13 requests and
returned 12 component hypotheses, 22 terminal records and two raw hole-association
candidates. Visual review found grid drift and questionable insertion positions.
The fitted landmarks disagreed by about 0.363 hole pitches; the calibration gate
now uses the same 0.32-pitch radius as hole matching and rejects that fit on local
replay. Most wire contacts were obscured or out of frame. This is an unsuccessful
connectivity reconstruction, not a validated accuracy result. Private artifacts
remain in the gitignored `benchmark-evidence` directory.

To run a real provider inspection from `praxis-backend/server`:

```sh
node --env-file-if-exists=.env --import tsx scripts/inspect-circuit.ts IMAGE.jpg OUTPUT.json
```

This sends the selected photograph and crops to Meta. The output is a proposal
bundle, not a human-confirmed circuit. The command refuses to overwrite an output file.
