# StreamDockBridge Roadmap

Canonical roadmap for StreamDockBridge. This file is the single source of truth for
what is built, what is proven, and what is merely planned.

## Status vocabulary

These labels are not interchangeable. Do not promote a item to a stronger label
without the evidence that label requires.

| Label | Meaning |
| --- | --- |
| `DONE` | Implemented and merged. Says nothing about proof. |
| `VERIFIED AUTOMATED` | The repository's own test/build/lint suite passes for it. Compile and test success only. |
| `VERIFIED RUNTIME` | Proven in a running system (real service, real browser, real HTTP), but not through the N4 Pro hardware. |
| `VERIFIED PHYSICAL` | The owner physically pressed the N4 Pro control and confirmed the observed result. |
| `WAITING PHYSICAL TESTING` | Agent-side work is finished; only the owner's hardware confirmation is outstanding. |
| `INVESTIGATION` | Research only. No implementation exists. |
| `PLANNED` | Agreed direction, not started. |
| `BLOCKED` | Cannot proceed; the blocker is named. |

Compile success is not runtime proof. Runtime proof is not N4 hardware proof.

---

## Phase 1 — Proven N4 Building Blocks

### Browser Context MVP — `VERIFIED AUTOMATED` + `VERIFIED RUNTIME` / `WAITING PHYSICAL TESTING`

Candidate SHA: **`12184d3dd027a2c2e464eae42d7acd1bb296e5b3`** (branch `feat/browser-context-mvp`).

The N4 Pro presses a key, the VSD Craft plugin posts to a loopback service, and the
service turns the focused Chrome tab's title into a lookup URL and opens it.

| Component | Status | Evidence |
| --- | --- | --- |
| Focused-window / current-tab Chrome context authority | `VERIFIED RUNTIME` | Live `GET /context` returned the focused tab's URL, title and derived `canonicalTitle`. |
| Local browser-context service (`127.0.0.1:17337`) | `VERIFIED RUNTIME` | `GET /health` → `200 {"status":"ok"}`. |
| IMDb action | `VERIFIED RUNTIME` | `POST /lookup/imdb` → `200`, `https://www.imdb.com/find?q=I%20See%20You`. |
| CAST action | `VERIFIED RUNTIME` | `POST /lookup/cast` → `200`, Google search + ` cast`. |
| JUSTWATCH action | `VERIFIED RUNTIME` | `POST /lookup/justwatch` → `200`, JustWatch US search. |
| REDDIT action | `VERIFIED RUNTIME` | `POST /lookup/reddit` → `200`; Chrome actually opened the tab (window title `I See You - Reddit Search!`). |
| Service-restart recovery | `VERIFIED RUNTIME` | After restart the store was `null`; the extension's recovery alarm repopulated it within 15 s with no browser interaction. |
| No-context behavior | `VERIFIED RUNTIME` | With an empty store, `POST /lookup/imdb` → `400 {"error":"no_usable_context"}`. |
| Automated suite | `VERIFIED AUTOMATED` | 46 tests / 8 suites; `verify:build`, `verify:ts`, `verify:lint`, `build`, `typecheck`, `lint`, `git diff --check` all clean. |
| **VSD Craft N4 physical acceptance** | **`WAITING PHYSICAL TESTING`** | **Not performed.** No profile in the host store references `streamdockbridge`. |
| **AUDIO FIX integration** | **`WAITING PHYSICAL TESTING`** | Third-party action; see the known issue below. |

The plugin installed at
`%APPDATA%\HotSpot\StreamDock\plugins\com.cmarabate.streamdock.streamdockbridge.sdPlugin`
is byte-identical to a cold build of this SHA (`dist/main.js`, `manifest.json`, all 11
images), so the artifact under test is provably the candidate.

#### Outstanding blockers for physical acceptance

1. The Chrome extension is **disabled** (`disable_reasons:[1]`) while the **Brave** copy
   is enabled. Brave is therefore the live context authority. Two enabled copies would
   race for the single-slot context store, so exactly one browser must own it.
2. `USEFUL v2.StreamDockProfile` has never been imported. The `USEFUL` profile present
   on the device is a decoy whose buttons are plain `com.hotspot.streamdock.system.website`
   actions and exercise none of this code.
3. AUDIO FIX device data is wrong — see below.

#### Known issue — AUDIO FIX device binding

`scripts/packageCleanProfile.js` hardcodes
`device1: "Speakers"` / `device1Name: "Speakers (Realtek High Definition Audio)"`.
The vendor plugin (`com.lizard.switchaudio.toggle`) expects an endpoint **ID** in
`device1`, and its own enumerator lists no device by that name on this machine — the
real Realtek endpoint is `Speakers (Realtek(R) Audio)`. Both the primary and fallback
switch paths therefore fail silently with no alert. Selecting the device in the vendor
property inspector rewrites these settings correctly at runtime. Repairing the
hardcoded values is deferred until the physical canary proves which device works.

### Cold-build regression — `DONE` / `VERIFIED AUTOMATED`

`packages/vsd-plugin` previously ran `esbuild && tsc -b`. Both emit into `dist/`, and
tsc's `outDir`/`rootDir` make it emit `dist/main.js` from `src/main.ts`, so tsc ran last
and overwrote esbuild's 131,575-byte self-contained bundle with a 1,828-byte unbundled
file that `require("ws")` at runtime. Because the plugin manifest points `CodePathWin`
at `dist/main.js` and the installed `.sdPlugin` carries no `node_modules`, that artifact
cannot resolve `ws` and the plugin fails to start — taking all four bridge actions with it.

A warm build hid the defect entirely: `tsc -b` skips emit while `tsbuildinfo` is current,
so the surviving bundle looked correct. Only a cold build reproduced it.

Repaired in `12184d3` by reordering to `tsc -b && esbuild`, matching `packages/extension`.
`packages/vsd-plugin/src/buildOrder.test.ts` covers both bundled packages, since no
existing test could observe a cold-build-only failure.

---

## Phase 2 — Programmable Bridge

### Architecture decision — `DONE` (decision recorded)

```
N4 Pro
  → StreamDockBridge VSD plugin
    → authenticated StreamDockBridge loopback service
      → narrow downstream capability adapters
```

One narrow adapter per capability. No generic proxy, no caller-supplied downstream URL,
no master scene. The service keeps sole authority over what may be invoked and over the
browser context it already owns.

Rationale: the VSD Craft SDK is a clone of Elgato's classic SDK and already provides
`setTitle`, `setImage`, `setState`, `showOk`, `showAlert` and a bidirectional JSON
property-inspector channel. The plugin runs as full Node 20. Every capability needed for
Phase 2 exists on a transport that is already physically installed.

### Rejected primary bridges — `INVESTIGATION` (complete)

**Companion** — the MiraBox surface module has no N4 Pro model definition; the upstream
issue has been open since 2026-01-10 pending firmware. It therefore cannot drive the
device, reducing it to an extra network hop behind our own plugin. Its HTTP control API
is unauthenticated and binds all interfaces by default, which is a weaker boundary than
our loopback service with a `timingSafeEqual` secret. The token-scoped `/api/v2` that
would fix this is unreleased. Adopting it would also add a resident Electron app that is
not currently installed.

**PythonScriptDeck** — targets the Elgato SDK generation (`SDKVersion: 3`, host app 7.0);
nothing on this machine exceeds `SDKVersion: 2`, so it is unproven-to-incompatible with
VSD Craft. Its upstream repository is a 404, leaving only an unlicensed third-party
mirror. It offers no capability the incumbent SDK lacks.

**IdeaForge** — not directly invocable. It is a Manifest V3 Chrome extension and an HTTP
*client*, not a server; it consumes AgentOS rather than exposing a hardware-command API.
Its only other local surfaces are a native host that terminates processes by port, and an
optional Python transcription service that is not running.

### Phase 2A — Transcribe Current Video — `VERIFIED AUTOMATED` + `VERIFIED RUNTIME` / `WAITING PHYSICAL TESTING`

One capability: send the currently focused browser URL to TranscriptForge for
transcription, and report the outcome on the button.

```
N4 keyDown
  → StreamDockBridge VSD plugin
    → authenticated StreamDockBridge local service
      → narrow TranscriptForge adapter
        → TranscriptForge runtime-health check
          → idempotent current-URL enqueue
            → normalized result
              → VSD feedback (showOk / showAlert)
```

The caller supplies no URL, no path, and no method. The service reads the current URL
from its existing browser-context authority and may reach exactly one downstream
capability. TranscriptForge's destructive routes are never reachable from the device.

Service route: `POST /actions/transcribe-current`, behind the same `X-Bridge-Secret`
gate as `POST /context`. The adapter's entire downstream surface is the literal union
`'/api/runtime/identity' | '/api/jobs'`, so a caller-chosen path is not representable.

Verified TranscriptForge contracts used (read from deployed source at
`D:\_Dev\_runtime\TranscriptForge`, which is a worktree of the dev repo and
content-identical to it):

- `GET /api/runtime/identity` → `{app, protocolVersion, appVersion, worker:{status}}`.
  `worker.status` is one of `healthy | stale | none`; `healthy` means an unexpired
  worker lease (20 s TTL). This route asserts a loopback `Host` header — it must name
  `127.0.0.1` exactly, so `localhost` returns 403.
- `POST /api/jobs` with `{urls:[url]}` → always **200** with
  `{results:[{url, jobId, skippedReason}]}`. The discriminator is `skippedReason`, not
  `jobId`: a deduplicated submission returns a **non-null** `jobId` alongside a non-null
  `skippedReason`. Dedupe matches the normalized URL and excludes only `failed` and
  `cancelled`, so a `complete` job also suppresses re-enqueue. This route has no auth,
  no origin check and no loopback assertion.

| Behaviour | Status |
| --- | --- |
| Unauthenticated / wrong secret rejected before any downstream call | `VERIFIED AUTOMATED` + `VERIFIED RUNTIME` (live 401) |
| Disallowed origin rejected | `VERIFIED AUTOMATED` |
| No browser context → `400 no_usable_context` | `VERIFIED AUTOMATED` |
| Unsupported context URL → `400 unsupported_context_url` | `VERIFIED AUTOMATED` + `VERIFIED RUNTIME` (live 400 on a real page) |
| Unhealthy/stale worker refuses to enqueue | `VERIFIED AUTOMATED` |
| Downstream unreachable → `503 downstream_unavailable` | `VERIFIED AUTOMATED` |
| Successful enqueue → `queued` + jobId | `VERIFIED AUTOMATED` |
| Deduplicated enqueue → `already_queued` + existing jobId | `VERIFIED AUTOMATED` + `VERIFIED RUNTIME` (live, created no row) |
| Downstream error normalized, response shape not leaked | `VERIFIED AUTOMATED` |
| Caller cannot select downstream URL, path or method | `VERIFIED AUTOMATED` |
| VSD `showOk` / `showAlert` / `setTitle` feedback | `VERIFIED AUTOMATED` |
| **N4 Pro physical press** | **`WAITING PHYSICAL TESTING`** |

#### URL admission mirrors the downstream provider registry

TranscriptForge accepts any syntactically valid URL and only fails later, in the worker.
Runtime validation proved this the hard way: submitting an ordinary streaming page
enqueued a job that died with `No provider registered for platform "unknown"`
(`failure_code: no_provider`, non-retryable) and left a dead row behind. The bridge
therefore admits only URLs TranscriptForge has a provider for — YouTube, TikTok, Pocket
Casts, and podcast feeds / direct audio files. Instagram, X and Facebook are excluded
because TranscriptForge lists them in `RECOGNIZED_UNSUPPORTED_PLATFORMS`. This list
mirrors downstream behaviour and must be widened if TranscriptForge gains providers.

#### Deployment note

The plugin exposes the new action, but `USEFUL v2.StreamDockProfile` was intentionally
left unchanged so the pending Browser Context MVP canary still tests the same artifact.
The button is added by dragging **StreamDockBridge → Transcribe Current Video** onto a
free key in VSD Craft.

### Phase 2B — AgentOS Safe Hardware-Action Contract — `INVESTIGATION`

AgentOS exposes a live loopback control service whose only authentication is a single
fixed, public header value. Its `queue-to-run` route is idempotent by design, but its
body is a task packet bound to persisted ledger lineage — a button can replay such a
packet but cannot construct one. The running instance has its background reconciler
armed, so admission causes real dispatch; the source records a 2026-08-23 production
incident in which that path dispatched an unintended historical intent.

A safe hardware-action contract must therefore be designed before any button is wired to
AgentOS. Not authorized for implementation.
