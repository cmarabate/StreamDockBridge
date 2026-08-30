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

#### Physical canary results so far

The owner pressed the N4 IMDb key on 2026-08-30 after importing `USEFUL v2`.

| Control | Physical result |
| --- | --- |
| IMDb | **Transport verified** — N4 → plugin → service → browser search all fired correctly. **Lookup semantics failed**: the query carried the season qualifier. Repaired; awaiting retest. |
| CAST | awaiting physical test |
| JUSTWATCH | awaiting physical test |
| REDDIT | awaiting physical test |
| AUDIO FIX | awaiting physical test |
| TRANSCRIBE | awaiting physical test |

This is the first real hardware evidence: the whole chain from key press to launched
browser works. Only the search term was wrong.

#### Work-level title normalization — `DONE` / `VERIFIED AUTOMATED` + `VERIFIED RUNTIME`

The failing context, captured live:

```
url            https://www.amazon.com/gp/video/detail/0QD2FDHVUZNOEJDT5JE9SSRBQX/…
rawTitle       Watch Gary and His Demons Season 2 | Prime Video
og/twitter/jsonLd   (all empty)
canonicalTitle Watch Gary and His Demons Season 2 | Prime Video   ← unchanged
```

Three defects, not one: `Prime Video` was absent from the provider-suffix list, there was
no season/episode handling at all, and the `Watch ` prefix survived. All four lookups read
`contextStore.canonicalTitle`, so there is exactly **one** title authority and it was
repaired once.

Strategy, in the order the brief requires:

1. **Structured series metadata wins outright.** The extension now reads schema.org
   `partOfSeries`, `partOfSeason.partOfSeries` and `isPartOf` and sends `jsonLdSeriesTitle`.
   When a page states the series it belongs to, that is the work title and no string
   surgery competes with it. A bare `isPartOf` URL carries no title and is ignored.
2. **Bounded fallback** only when no structured series exists — which is exactly the
   Prime Video case, where the page exposed no JSON-LD at all.

Safety of the fallback: every qualifier must begin at a word gap and run to end of string,
so `District 9`, `1923`, `Catch-22`, `9-1-1`, `Se7en`, `M3GAN`, `Blade Runner 2049`,
`Season of the Witch` and `Star Wars: Episode IV - A New Hope` are untouched. `Part N` and
`Vol. N` are deliberately **not** stripped — real titles use them (`Kill Bill: Vol. 2`,
`Deathly Hallows: Part 2`). A strip that would empty the title is rejected, so `Season 2`
alone survives. Two bugs of this class were caught by the tests during development:
`Ocean's 11` lost its tail to the S-code pattern, and `Preseason 2` would have lost its
head.

Runtime proof against the real failing context — all four now query
`Gary and His Demons`.

#### Outstanding blockers for physical acceptance

1. The Chrome extension is **disabled** (`disable_reasons:[1]`) while the **Brave** copy
   is enabled. Brave is therefore the live context authority. Two enabled copies would
   race for the single-slot context store, so exactly one browser must own it.
2. The profile has never successfully imported. An owner attempt on 2026-08-30 was a
   **silent no-op** — no error dialog, no new profile, nothing on the device. Diagnosed
   and repaired; see *Silent profile-import failure* below. The repaired artifact is
   `USEFUL v2.streamDockProfile` and has not yet been imported.
3. AUDIO FIX device data is wrong — see below.

#### Silent profile-import failure — `DONE` (repaired) / awaiting host import proof

VSD Craft accepted the import click and did nothing: no dialog, no profile, no device
change, reproducible. Ground truth came from the 153 profile packages the app ships
under `defaultData/defaultProfiles` (341 page manifests, 2473 actions, including a
`VSDN4Pro` set for this exact device). Three deviations from that corpus were found and
fixed in the generator:

1. **File extension casing — leading candidate, unproven.** The host's packages are all
   `.streamDockProfile`; ours was `.StreamDockProfile`. `VSD Craft.exe` holds an
   accepted-suffix table for `SDProfileManager::importProfile` containing both
   `SDProfile` and `sdprofile`, hinting at a case-sensitive compare. Counter-evidence:
   the Qt dialog filter offers `*.mKeyProfile`, which could never match the
   lowercase-only `mkeyprofile` entry under a case-sensitive compare. The table is
   equally consistent with a case-insensitive match.
2. **Page manifest missing `DeviceModel`, `DeviceUUID`, `Version`.** Present in 341/341
   host page manifests. A page that does not name its device cannot be bound to one.
3. **Image references.** Package-local art is referenced by **bare basename**, resolved
   under `Images/`. An `Images/<name>` value denotes an app *built-in* resource — all 18
   such host values are absent from their own packages. Ours wrote `Images/<name>.png`,
   naming built-ins that do not exist, and additionally nested
   `Images/actions/record/`, a shape with zero precedent in 1074 host image entries.

Ruled out rather than "fixed" on appearance: our page-ID format already matched the host
`8-4-4-4-12` uppercase-base36 shape (355/355), an empty root `Actions` is legal (20/153),
and `AppIdentifier` and the `manifest.json.*.bak` siblings are common but not universal.

**Why verification did not catch it.** The validator was self-referential: it asserted
the generator's output against expectations derived from that same generator, so a
package no host would accept still passed. It is now anchored to the surveyed host
contract and cross-checks against a real `VSDN4Pro` package from the install.

**No cause is proven.** All three are real conformance defects against a corpus with no
counterexamples, and all three had to be fixed regardless. But no log line records the
import at all — there is no occurrence of `USEFUL`, `importProfile`, or the page UUID
`F06684D5` in any log file. An earlier reading of a `Can not find profile ...
pathExists: true` line as evidence was **wrong**: it names a since-deleted local store
profile and the generator's *previous* page UUID, and is emitted during a UI redraw, not
an import. A dangling `Pages.Current` is also routine — 100/153 host packages ship that
way.

Untested alternatives that remain open: page-UUID or profile-name collision with the
local store (the generator's own comments record this producing exactly "no new profile
appears" once before), and current-device scoping at import time
(`onImportProfile_CurrentDev`). The next import distinguishes all of them.

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

Exposing the action in the plugin manifest does not put a button on the deck — the
profile binds keys to action UUIDs independently. `USEFUL v2.streamDockProfile` now
carries a seventh control, **TRANSCRIBE** at slot `1,2`, generated through
`scripts/packageCleanProfile.js` like every other key. The six Browser Context and
AUDIO FIX controls are unchanged. It reuses the plugin's own icon, since no dedicated
key art exists for it yet.

### Context URL template primitive — `DONE` / `VERIFIED AUTOMATED` + `VERIFIED RUNTIME` / `WAITING PHYSICAL TESTING`

The four built-in lookups revealed the general primitive. Rather than adding a hard-coded
action per site, one configurable action carries a URL template and fills it from the
current browser context.

```
N4 key (its own urlTemplate)
  → VSD plugin
    → authenticated POST /lookup/custom   { "template": "..." }
      → service reads its OWN browser context
        → approved placeholders substituted and percent-encoded
          → resolved URL validated
            → browser opens it
```

**Action:** `Context URL`, UUID `com.cmarabate.streamdock.streamdockbridge.contexturl`,
Property Inspector at `propertyInspector/contextUrl.html`.

**Settings schema:** exactly one key, `urlTemplate: string`. Title and icon are the host's
own generic controls and are deliberately not duplicated.

**Placeholders:** `{title}` (the existing canonicalTitle authority — no second title
cleaner exists), `{rawTitle}`, `{url}`, `{hostname}`. Not an expression language: no
property paths, no function calls, no arbitrary names. An unknown placeholder is a
configuration error, never a silent pass-through.

**Security.** Only `http:` and `https:` resolve; every other scheme, malformed URL and
credential-bearing URL is refused, and nothing is opened on refusal. The service never
fetches the URL — it hands a validated destination to the existing browser-open path.
The caller supplies only the template; every substituted value comes from the service's
own context, so a key cannot carry a stale media title or name a value the context does
not hold. The route sits behind the existing `X-Bridge-Secret` gate.

**Per-instance settings.** The host stores each key's settings in the page manifest under
`Actions["<col>,<row>"].Settings` and hands them to the plugin in `payload.settings` at
keyDown. The plugin keeps no cache, so instances cannot share or overwrite one another.
Verified against the host's own store, where a shipped third-party plugin already keeps
four same-UUID slots with differing settings.

**Built-ins are now presets** on the same resolver — `{title}` templates with their
destinations unchanged byte-for-byte, including CAST's literal `%20cast`. Their UUIDs,
routes and profile bindings are untouched, so no profile migration is needed.

Runtime-proven: two templates resolved independently against the same live context to
`youtube.com/results?search_query=Gary%20and%20His%20Demons+trailer` and
`rottentomatoes.com/search?search=Gary%20and%20His%20Demons`. VSD Craft registered the
action in its own catalog (`StreamDockConfig.ini`), and the Property Inspector was driven
through the host's real bootstrap contract.

Outstanding: the owner dragging the action onto keys and pressing them.

### Phase 2B — AgentOS Safe Hardware-Action Contract — `PLANNED` (design agreed, not implemented)

No button is wired to AgentOS. This section is the contract that must hold before one is.

#### Why AgentOS is not TranscriptForge

Phase 2A was safe to build because TranscriptForge's enqueue is self-contained and
idempotent on the URL, and its worst outcome is a dead job row. None of that transfers.

`POST /api/ideaforge-intake/queue-to-run` creates execution lineage, and the running
instance has its background reconciler **armed**, so admission leads to real dispatch to
a real runner. Its body is a task packet validated against `capturedItemId`,
`repositoryId`, `taskId`, `workItemId` and persisted ledger lineage — a button can
*replay* such a packet but can never construct one. And the source records a
**2026-08-23 production incident** in which a constrained canary released a blocked lane
head, the shared repository lane advanced, and a non-target historical intent was
dispatched and given a TL-4 authorization.

So "press equals dispatch" is not an option, and mapping a key onto `queue-to-run` is
explicitly rejected.

#### The boundary: hardware intents, not commands

The device emits an **intent name from a closed enum**. No payload, no identifiers, no
path, no method — the same shape that made Phase 2A defensible, applied to a downstream
where the stakes are higher.

Ownership is explicit and one-way:

- The **device** owns nothing but "this key was pressed".
- The **bridge service** owns the intent → (AgentOS path, method, resolved target) map,
  and is the only component permitted to speak to AgentOS.
- **AgentOS remains the workflow authority.** The bridge never stores workflow truth,
  never re-derives lane order, never invents lineage, and never becomes a competing
  source of dispatch state.

#### Intent set

| Intent | Kind | AgentOS surface |
| --- | --- | --- |
| `agentos.status` | read-only | `GET /health`, `GET /api/ideaforge-intake/queue-lanes` |
| `agentos.pending-count` | read-only | `GET /api/ideaforge-intake/operator-actions` |
| `agentos.confirm-armed-item` | **mutating, gated** | preview then `POST /api/ideaforge-intake/queue-to-run` |

The two read-only intents ship and reach physical acceptance **first**. The mutating
intent is not built until they have.

Never reachable from a key, and absent from both the enum and the path allowlist:
`POST /api/ideaforge-intake/queue-lanes/reorder` (silently reprioritizes operator-visible
work) and `POST /api/ideaforge-intake/operator-action-response` (answers a human decision
on the operator's behalf).

#### Arming is out-of-band; the button only confirms

A single press must never select *and* admit. The work item is armed elsewhere — the
IdeaForge side panel or the AgentOS CLI — producing an arm record the bridge can read.
The key confirms what a human already chose. With nothing armed the action refuses with
`nothing_armed` and makes no AgentOS call at all.

#### Target resolution

The device never names a target. For the mutating intent the service must:

1. resolve candidates from AgentOS's own read routes, never from device input;
2. require **exactly one** armed candidate, else refuse `ambiguous_target`;
3. preview it write-free via `GET /api/ideaforge-intake/queued-work-plan?workItemId=…`,
   which AgentOS documents as write-free by construction, before any admission.

#### Replay and duplicate protection

- The arm record carries a token with a **short expiry** (~120 s). Expired → refuse.
- The service remembers the last confirmed token. Re-presenting it is a no-op success
  (`already_confirmed`), never a second admission. Key-mashing cannot fan out.
- Immediately before admitting, the write-free preview is re-run and must still match the
  armed snapshot — `workItemId`, `repositoryId`, and lane head. Any drift refuses with
  `target_drifted`. **This is the specific guard against the 2026-08-23 failure mode**,
  where the lane advanced between decision and dispatch.
- A per-intent cooldown bounds press frequency.
- AgentOS's own `already_admitted` response is treated as success, matching its documented
  idempotency, so a retry after a lost response cannot double-admit.

#### Authentication

AgentOS's only auth is a fixed, public header value — it is not a boundary and must not be
treated as one. The real gate is the bridge's existing `X-Bridge-Secret`, exactly as in
Phase 2A.

#### Feedback

`showOk` on `confirmed` and `already_confirmed`; `showAlert` on every refusal; a brief
title naming the refusal category (`nothing_armed`, `ambiguous_target`, `target_drifted`,
`expired`). A mutating intent is **never** auto-retried.

#### Acceptance staging

- **2B.1** — read-only intents: automated, then runtime, then physical.
- **2B.2** — confirm intent: automated and runtime against a disposable AgentOS state
  root if one can be stood up; otherwise a single owner-supervised confirm. Not started
  until 2B.1 is `VERIFIED PHYSICAL`.
