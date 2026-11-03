# Fixed-camera two-LED demonstration

Open **Camera demo** from the photograph workspace, or visit `/camera`.
The implementation uses explicit captured frames and human-reviewed contacts.
It does not track hands or continuously infer wiring from video.

## Deploy the frontend and tunnel the local backend with ngrok

This setup gives the phone a normal HTTPS frontend while the backend keeps running
on your computer. A hosted frontend cannot reach your computer through `localhost`
or a private LAN address. Set its server-side backend URL to the ngrok HTTPS URL:

```text
Phone → deployed Next.js frontend → ngrok HTTPS URL → computer:3000
```

Deploy the frontend as a Next.js application with API routes, rather than a static
export. The browser uses the frontend's `/api/*` routes; those routes already proxy
to `PRAXIS_BACKEND_URL` and attach `PRAXIS_API_TOKEN`. No browser CORS change is needed.

1. Generate a backend API token with `openssl rand -hex 32`. Put the generated value
   in `praxis-backend/server/.env`, keeping your existing `META_API_KEY`:

   ```dotenv
   HOST=127.0.0.1
   PORT=3000
   PRAXIS_API_TOKEN=REPLACE_WITH_GENERATED_TOKEN
   ```

   Restart the backend from `praxis-backend/server` with `npm run dev`.
2. Install and authenticate ngrok on the same computer. On macOS:

   ```sh
   brew install ngrok
   ngrok config add-authtoken YOUR_NGROK_AUTHTOKEN
   ngrok http http://127.0.0.1:3000
   ```

   Get the ngrok authtoken from your ngrok account dashboard and enter it locally.
   It is a different credential from `PRAXIS_API_TOKEN`.
3. Copy the **HTTPS forwarding URL** ngrok prints. In your frontend hosting
   provider's environment settings, configure:

   ```dotenv
   PRAXIS_BACKEND_URL=https://YOUR_NGROK_DOMAIN
   PRAXIS_API_TOKEN=THE_SAME_GENERATED_BACKEND_TOKEN
   ```

   Use the URL's root without `/api`. Keep both variables server-only, without a
   `NEXT_PUBLIC_` prefix. `META_API_KEY` stays on the backend computer.
4. Deploy or redeploy the frontend after saving these variables. Open its **HTTPS
   frontend URL** on the phone, visit `/camera`, and allow camera access. You do not
   need the local mkcert setup for a frontend hosted with trusted HTTPS.

Leave the computer awake, online, and running both the backend and ngrok. This is a
tunnel to the local process, not backend hosting. If the forwarding URL changes,
update `PRAXIS_BACKEND_URL` and redeploy the frontend.

For a connection check, `https://YOUR_NGROK_DOMAIN/health` should return the backend
health JSON. This route does not require the API token; session routes do. The
phone should use the deployed frontend, not call the ngrok backend directly.

See [ngrok's CLI quickstart](https://ngrok.com/docs/gateway/endpoints/agent-cli-quickstart)
for installation and account setup.

## Use the camera from a phone on the local network

Phone browsers block live camera access at HTTP LAN addresses such as
`http://192.168.100.42:3001`. The localhost exception applies only on the device
running the browser. Use HTTPS with a certificate trusted by the phone.

1. Install [mkcert](https://github.com/FiloSottile/mkcert#installation) on the
   computer hosting Praxis (`brew install mkcert` on macOS).
2. From `praxis-frontend`, create a certificate for the computer's current LAN IP:

   ```sh
   mkcert -install
   mkdir -p certificates
   mkcert -key-file certificates/lan-key.pem -cert-file certificates/lan.pem 192.168.100.42 localhost 127.0.0.1
   mkcert -CAROOT
   ```

3. Transfer only `rootCA.pem` from the folder printed by `mkcert -CAROOT` to your
   phone and install it as a trusted CA certificate. On iPhone, install the profile
   in Settings, then enable it under **General → About → Certificate Trust Settings**.
   On Android, use Settings' **Install a certificate → CA certificate** option
   (the exact menu varies). Keep `rootCA-key.pem` and `lan-key.pem` private on the
   computer. See [mkcert's mobile setup](https://github.com/FiloSottile/mkcert#mobile-devices).
4. Stop the existing frontend on port 3001, then run:

   ```sh
   npm run dev:https
   ```

5. On the same Wi-Fi network, open **https://192.168.100.42:3001/camera** in Safari
   or Chrome, tap **Start camera**, and allow camera access. The page must load
   without a certificate warning; bypassing a warning may still block camera access.

Keep the backend running on its normal loopback address; browser API requests go
through the frontend. The Next.js configuration allows the computer's current IPv4
addresses as development origins so its development WebSocket can connect and the
page becomes interactive. If the computer's IP changes, regenerate `lan.pem` and
`lan-key.pem` for the new IP and restart the frontend. The certificate files are
gitignored. Normal computer-only development still uses `npm run dev`.

Browser camera requirements: [MDN getUserMedia](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia).

## Physical setup (off stage)

1. Assemble and independently check the actual circuit:
   - Supply → R1 → green LED D1 → ground.
   - Supply → normally-open S1 → R2 → J1 → red LED D2 → ground.
   - Use the actual verified supply, resistor values, LED roles and switch contact mapping. The form's initial 5 V / 1 kΩ entries are draft suggestions, not hardware verification.
2. Fix the camera and board. Route J1 with both insertion points visible. Put four unique fixed marks around the circuit, outside the wire being moved. Repeated holes and plain areas are unsuitable landmarks.
3. Create a **New circuit session**, start the camera, and **Capture setup**. Inspect the frozen photograph and exact inference manifest before **Approve and scan this frame**. Alternatively, explicitly open a saved healthy analysis; no historical ID is selected automatically.
4. In **Saved image workspace**, calibrate the board and register rail continuity. In **Connectivity**, save the workspace, identify all relevant components, set terminal roles, confirm actual conductive contacts and topology, and explicitly review conductive coverage. Exclude duplicate hypotheses only after review.
5. A manually identified switch has two effective contacts, `contactA` and `contactB`. Additional physical legs can be registered as verified aliases of one contact. Confirm each additional leg's actual insertion too. No four-pin orientation is assumed. `open`, `closed` and `unknown` remain device states; they do not short A and B into a wiring net.
6. **Refresh reviewed setup evidence**. Map P1, R1, D1, S1, R2, J1 and D2 to seven distinct reviewed objects. J1 role `a` is its fixed R2-side end; `b` is its movable LED-side end. Record the schematic and actual part/contact sources, reviewer, reason and landmark coordinates in source-image pixels.
7. **Save draft profile** until those details are verified. **Freeze verified physical profile** requires a fully reviewed healthy graph matching the intended design. Synthetic sources cannot qualify as a real rig. Profile versions and earlier reviews remain immutable.

## Fault and repair demonstration

1. Place J1's movable end in a known empty, incorrect strip. Keep its R2-side end fixed.
2. **Scan circuit** and approve that frame's manifest. The broad detector runs once. Whole-image inventory, automatic recovery and full-scene Muse interpretation are disabled for this bounded capture.
3. **Check registration and load setup facts**. Four distinctive patches must match the setup at the same source coordinates. Camera/board movement, obscured landmarks, dimension changes or ambiguous marks prevent transfer. This registration check does not establish contact visibility.
4. Select the actual current SAM wire observation representing J1. Optional **Preview endpoint interpretation** constructs the exact cropped request offline. A separate approval can dispatch one Muse request. Its points remain proposals; hidden contacts must remain unknown. A/B endpoint labels do not establish polarity or which logical end they represent.
5. Review the actual anchored and movable insertion holes. Explicitly confirm wire identity, intact continuity, both visible insertions and unchanged static contacts; supply reviewer and evidence. **Save fresh physical review and diagnose**. Expected holes are never prefilled as observed positions.
6. A confirmed discrepancy explains the missing R2-to-D2 relationship and actual observed endpoints. The selected J1 mask pulses red. Hover its mask or connection edge to inspect its counterpart. The connection projection preserves wire edges before conductive union; the netlist shows final unioned nodes and separate typed devices.
7. Select a visibly empty, accessible hole on D2's anode net and attest that availability. **Validate single-end move and show guidance** checks current hashes, anchor identity, occupancy, registered topology, the counterfactual relationship and forbidden net merges/changes to the green branch. Ambiguous destinations do not yield arrows.
8. The arrow is always labeled as last-scan guidance. Live guidance additionally requires explicit clear-view confirmation and matching fixed landmarks and J1-region pixels. Scene changes pause it. These local image checks do not recognize hands or prove electrical contact.
9. Move the physical lead, clear the view, and **Verify repair — capture**. Approve the new scan, check registration, and review both new insertions. **Evaluate fresh repair capture** requires a different capture, analysis and photograph hash, the same profile, an unchanged anchor and current fresh review. Editing the old graph cannot resolve a repair.
10. Outcomes are **resolved**, **not resolved** or **unable to verify**. A restored relationship is not an automatic electrical-operation test. Press the real button and observe D2 illuminating separately.
11. **Export session evidence** saves profiles, frames, native checkpoints, raw request/response evidence, request/pixel accounting, registration evidence, reviews, graphs, findings, repair instructions and verification decisions. Resume a saved session by its explicit ID or the browser's **Resume last session** button. Analysis retention/deletion still applies. Export each rehearsal cycle while its images remain retained.

## Request limits

Each approved frame permits up to **four SAM requests**: breadboard, LED, resistor and wire. This preserves the existing broad pass. Frames are resized without cropping or mirroring to at most 1.5 million pixels, so the combined SAM input is at most **six million pixels**. Original camera dimensions and the resampling transform are recorded.

Endpoint interpretation permits at most **one separately approved Muse request** and **four million input image pixels**, including every grounding/context image. There are no automatic retries or hidden inventory calls. Dispatch intent is persisted before transport; unknown usage remains spent across restart. Legacy inference/retry controls are blocked for camera captures. A new scan requires a new manifest and approval.

Graph review, repair simulation, comparison, hover, verification scoring and export make **zero provider calls**. Development tests use mocked provider transports and simulated camera pixels.

## Validation status

Automated engine, HTTP, restart and browser tests exercise healthy/faulty/repaired fixtures, both wrong strips, switch semantics, stale plans, duplicate clicks, permission denial, occupancy, drift/obscurity, unchanged faults and missing evidence. Their success is **synthetic software validation**.

The actual supply, breadboard, LED/resistor specifications, pushbutton part/contact mapping, healthy photograph and rehearsal captures have not been supplied. The physical demonstration remains pending. Freeze the real profile and archive healthy → faulty → repaired captures before claiming physical acceptance; then rehearse ten complete cycles with no incorrect confirmed diagnosis or repair verification.
