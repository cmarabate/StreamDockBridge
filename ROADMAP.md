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

### Context URL template primitive — `DONE` / **`VERIFIED PHYSICAL`**

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

**Settings schema:** `urlTemplate: string`, plus `autoWebsiteIcon: boolean` added by the
Auto Website Icon slice below. Title remains the host's own generic control and is
deliberately not duplicated.

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

**Physically accepted by the owner on 2026-08-30**, at
`4134266e3b0ffbd195090450e7416c23e250bccd`. The owner configured two Context URL
instances on the N4 Pro and confirmed:

- each key persisted its own URL template;
- configuring one did not affect the other;
- both resolved against the current canonical media title;
- both opened their intended destination;
- templates can be changed from VSD Craft with no rebuild of StreamDockBridge.

That last point is the product criterion this slice existed to satisfy.

### Auto Website Icons for Context URL — `DONE` / **`VERIFIED PHYSICAL`** (one open quality defect)

Context URL configures itself visually: paste a template, and the site's own icon appears
on the key. One reusable action, no per-site artwork.

```
key settings { urlTemplate, autoWebsiteIcon }
  → plugin derives nothing; sends ONLY the template
    → authenticated POST /icon/site
      → origin derived from the template alone
        → public-destination policy, pinned DNS, per-hop revalidation
          → bounded HTML discovery, then /favicon.ico
            → bytes sniffed, bounded, returned as a data URI
              → plugin setImage (volatile overlay, re-applied on willAppear)
```

**Setting.** `autoWebsiteIcon: boolean`, default ON. Absent means ON, so keys configured
before this slice inherit it. Per-key, stored alongside `urlTemplate`.

**Origin derivation** (`siteIcon.ts`) is pure and network-free. Placeholders are
substituted with two different probe tokens and the resulting authorities compared: equal
means a stable host, different means the authority depends on the current page and the
icon is refused as `dynamic_host`. The icon is a property of the configured SITE, never of
the media, which is what makes a title change cost nothing.

**Two capabilities, two policies.** Context URL may still OPEN `http://localhost:3000` in
the browser. The service will not FETCH from it. `ipPolicy.ts` gates server-side retrieval
to publicly routable HTTP(S) on ports 80/443 only, covering loopback, RFC1918, CGNAT,
link-local and cloud metadata, multicast and reserved space, IPv6 loopback/ULA/link-local,
IPv4-mapped IPv6 **including the hex rendering the resolver actually returns**, NAT64 and
6to4 embeddings, Teredo, and the documentation ranges. IPv6 is an allowlist (global
unicast only), so a range overlooked becomes a false reject and never a bypass.

**Pinned DNS.** Node calls a custom `lookup` once per connection and connects to exactly
what it returns, which closes the check-then-connect rebinding window. It returns exactly
one approved address, because with `autoSelectFamily` every returned address becomes a
connection candidate. The hostname stays in `host`, so SNI and certificate validation are
unaffected. No connection pooling: a keep-alive socket must not outlive its policy check.

**Every redirect hop is judged alone** — the configured origin earns its redirect target
nothing. Redirects into private space, to non-web ports, to other schemes, or carrying
credentials are refused before a socket is opened.

**Discovery** reads a bounded page prefix (192 KB) and ranks `rel=icon`,
`rel="shortcut icon"` and `apple-touch-icon` by declared size — smallest that still covers
the ~126 px key, then largest below it — falling back to `/favicon.ico`. Oversized HTML is
truncated rather than treated as an error, because a real homepage routinely exceeds any
sane cap and the `<head>` sits at the start; Rotten Tomatoes does not resolve otherwise.
No JavaScript is parsed or executed. This is not a brand-logo crawler.

**Accepted bytes:** PNG, JPEG, ICO and WEBP, chosen by magic bytes rather than
`Content-Type`, which is frequently wrong on `/favicon.ico`. ICO passes through undecoded
because the host's own decoder table accepts `image/x-icon`. SVG is refused despite the
host accepting it: it is XML handed to a renderer, carrying entity-expansion and embedded
-script surface. A PNG's IHDR dimensions are read without decoding, so a 10 KB file
declaring 30000×30000 cannot reach the host's decoder.

**Cache** (`iconCache.ts`) is keyed by origin, so every key on a site shares one download
and query or path edits never re-fetch. Bounds: 64 entries, 256 KB per image, 2 MB total,
LRU eviction, 14-day success lifetime and a 1-hour failure lifetime so a site with no
usable icon is not re-fetched on every appearance. Persisted to
`%APPDATA%\StreamDockBridge\iconCache.json` and revalidated on load — a malformed entry is
dropped rather than trusted, since this file feeds data URIs to the host's decoder.
Failures are deliberately not persisted, so a restart gives a failing site another chance.
One in-flight resolution per origin, so six keys appearing together cause one download.
Refresh invalidates exactly one origin and never flushes the cache.

**Generation ownership.** Each key carries a generation counter bumped by every event that
changes what it should show. A response whose generation is stale is discarded, so an old
template's icon can never land on a retargeted key, and a response arriving after the
owner switched the feature off never regains authority. State is dropped on
`willDisappear` and on socket loss, so nothing accumulates.

**Ownership semantics.** The plugin asserts an image only when it owns one. With the
setting ON it owns the overlay and re-applies it on every `willAppear`, because `setImage`
is volatile and the host rebuilds the key from the profile. With it OFF it stops resolving,
invalidates in-flight work, and applies the plugin's own default image once.

**Known limitation, honestly stated.** Host archaeology found no per-key operation that
restores the exact icon a user selected in VSD Craft. `VSD Craft.exe` contains no
`clearImage`, `resetImage`, `setDefaultImage` or `restoreImage`; `clearIcon` exists but is
a flag on the device-wide `setBackground`/`stopBackground` wallpaper events, not a per-key
command, and no shipped plugin restores a host-owned image after calling `setImage`. So
switching the setting off returns the key to **this plugin's** default image, not to a
manually chosen one; a manually selected icon reappears once the host reconstructs the key
(profile or page switch, or a VSD Craft restart), since the overlay does not persist.
StreamDockBridge is deliberately not coupled to private VSD profile-store internals to
work around this.

**Property Inspector** gains the checkbox, the derived website, an icon status
(Loaded / Cached / Unavailable / Disabled / Dynamic host / Local host), a preview, and
Refresh Icon. The panel is a `file://` page with an opaque origin and no bridge secret, so
it cannot call the service; it asks the plugin over `sendToPlugin` and is answered on
`sendToPropertyInspector`. Both events are routed by the host's own `SDPluginServer` and
are used by shipped plugins.

**Runtime-proven on the live host** at VSD Craft 3.10.202.0702 with the N4 Pro connected,
one plugin process, against the real internet:

- YouTube, Rotten Tomatoes and ReelGood icons rendered on their actual keys, coexisting;
- ReelGood served `image/x-icon` at 33,310 bytes and rendered — ICO pass-through, no decoder;
- editing only the query left the icon and the cache untouched;
- retargeting the host to Wikipedia repainted the key and reported `Loaded`;
- three media-title changes moved nothing — the cache file was not even rewritten;
- switching the feature off returned the key to the plugin default and reported `Disabled`;
- switching it back on restored the icon from cache, reporting `Cached`, with no fetch;
- Refresh Icon revalidated exactly one origin, leaving the other three timestamps intact;
- a profile switch away and back re-applied all icons with zero fetches;
- a full VSD Craft restart restored all icons from the persistent cache with zero fetches.

Live refusals confirmed against the running service: `localhost`, `127.0.0.1`, private
IPv4, `[::1]`, `169.254.169.254`, credential-bearing origins, non-web ports and dynamic
authorities were all refused without a socket being opened, and an unauthenticated call
returns 401.

**Adversarial review.** A read-only reviewer attacked SSRF, DNS rebinding,
redirect-to-private, address-selection, credential-bearing URLs, cache growth, stale icon
races, generation collisions, the toggle-off race, reconnect behaviour, unbounded
responses, malformed image types, and regression of both Context URL and the shell-free
launcher. **No HIGH findings**; it could not construct a working SSRF, a rebinding window,
a redirect-to-private, an XSS, or a crash path. Four MEDIUM and nine lesser findings were
raised and all were reconciled:

- the decompression-bomb guard covered PNG only, so a 2 KB JPEG declaring 65535×65535
  reached both the host's decoder and the panel's browser. Declared dimensions are now
  read for JPEG, ICO (including a PNG-compressed entry) and WebP as well;
- `/<link\b[^>]*>/g` was quadratic on hostile HTML — 192 KB of unterminated `<link` measured
  ~4s of blocked event loop, and this service is single-threaded, so it stalled keyDown
  launches too. Replaced with a linear bounded scanner;
- `isBlockedHostname` stripped one trailing dot, so `localhost..` and `169.254.169.254..`
  passed the first gate and were sent to the resolver (on Windows a `.local` name puts an
  mDNS query on the wire). The address gate still refused them, but the two-layer property
  had collapsed to one. All trailing dots are now stripped;
- the per-hop timeout was socket-inactivity only, so a server dripping a byte every four
  seconds held a hop — and its `inflight` slot — effectively forever, permanently pinning
  that origin to a promise that never settled. A wall-clock cap now bounds every hop, and
  the whole resolution shares one 20s budget that stays under the plugin's 25s timeout;
- plus: a cache entry could declare `bytes: 1` beside an unbounded data URI; Refresh
  silently no-opped when it coalesced onto an in-flight resolve; the plugin memo was
  bounded by count but not bytes; an ineligible declared href aborted the remaining
  candidates including the `/favicon.ico` fallback; a failed request for a superseded
  template skipped the generation check; two non-routable IPv6 ranges were accepted.

The reviewer explicitly confirmed the signed-shift arithmetic in `parseIpv4` is correct,
that no IPv4 class is missing from the block list, and that the Property Inspector has no
XSS sink.

Beyond the reviewer's findings, the dimension guard was tightened further: unreadable
dimensions are now a refusal rather than a pass, since a file crafted to defeat the header
read while a more lenient decoder resyncs would otherwise be admitted. Ten real sites,
including four ICOs, still resolve under the stricter rule.

**A second review pass over these fixes was dispatched but did not return**, so the
reconciliation itself has NOT been independently re-reviewed. It is covered by 452
automated tests and by cold-cache verification against ten live sites, and the fixes are
individually described above — but that re-review remains outstanding work, not a
completed gate.

**Physically accepted by the owner on 2026-08-30**, at
`db99cb7be959224a759012497949d9a8f7b35bea`. The owner tested on the N4 Pro and confirmed:

- automatic website icons function on the real hardware;
- Context URL key behaviour remains correct alongside them.

**One quality defect was reported and is now fixed.** The owner reported the **ReelGood
icon was visibly blurry**, and the supplied screenshot showed it already blurry in the
Property Inspector preview — an asset-selection defect, not N4 display scaling. The owner
did not report any other icon as poor, and no claim is made here about how any other
individual image looked. See the next section.

### Icon quality: choosing the best asset, not the first — `DONE` / `VERIFIED AUTOMATED` + `VERIFIED RUNTIME` / `WAITING PHYSICAL TESTING`

**Root cause, and it was generic.** `reelgood.com` answers its own homepage with **HTTP
403** while still serving a complete `<head>` that declares
`<link rel="icon" href="https://img.rgstatic.com/icon_120x120.png">`. The resolver only
harvested declared icons from a 2xx page, so it discarded that markup and fell through to
`/favicon.ico` — a 33 KB ICO whose largest entry is **64×64**, upscaled to a ~126 px key.

A second, independent defect made it worse: ranking used only the **declared** `sizes`
attribute, and ReelGood declares none, so even a harvested candidate would have been
ordered behind anything that bothered to declare itself. The resolver then took the
**first** acceptable candidate rather than the best.

**Fixes, none of them specific to ReelGood:**

- a page's `<head>` is harvested whatever its status code — a 403 still describes its own
  icons, and every harvested href is still policy-checked before it is requested;
- **web app manifest** icons are now a candidate source, bounded to 64 KB of JSON;
  `purpose: maskable` assets are skipped because they carry a safe-zone margin and render
  padded;
- `/apple-touch-icon.png` joins `/favicon.ico` as a conventional fallback;
- candidates are ordered by what the page *claims*, then **downloaded and scored on the
  pixels that actually arrived**, keeping the best — the declared score now only decides
  download order. Undeclared candidates rank ahead of declared-tiny ones, which is exactly
  the case that lost;
- scoring prefers the smallest asset that still covers the key (so 144 beats 512), then
  the largest that does not, using the **smaller side** because that is what bounds a
  square key, with a square-ness tiebreaker. Downloads stop early once something ideal
  arrives, so the common case still costs one image;
- at most 4 candidates are downloaded, inside the existing 20 s resolution budget.

**Cache migration.** `CACHE_VERSION` is now 2 and a file written by an older version is
discarded on load, so every origin is re-resolved by the current algorithm rather than
serving an asset an older one chose. No manual flush is needed.

**Measured result** against the real internet, cold cache — actual pixels, read from the
bytes that reach `setImage`:

| Site | before | after |
| --- | --- | --- |
| **reelgood.com** | **64×64** ICO | **120×120** PNG (`img.rgstatic.com/icon_120x120.png`) |
| rottentomatoes.com | 6 KB JPEG | **128×128** PNG (manifest icon) |
| imdb.com | small favicon | **60×60** apple-touch |
| en.wikipedia.org | 1313 B | **160×160** apple-touch |
| github.com | 32×32 ICO | **120×120** apple-touch |
| stackoverflow.com | 48×48 ICO | **180×180** apple-touch |
| bbc.co.uk | — | **128×128** touch icon |
| youtube.com | 144×144 | **144×144** (unchanged, already ideal) |

**Honest limits.** JustWatch publishes only a two-entry ICO (16×16 and 32×32) and Reddit
only 64×64; those are site ceilings, not resolver defects, and were confirmed by reading
the real ICO directories. IMDb's 60×60 apple-touch is likewise the best it offers on the
standard paths. Nothing here crawls a site for a brand logo.

**Visually confirmed in the host.** The ReelGood icon now renders crisp in the Property
Inspector preview — the exact surface where the owner saw it blurry. Physical confirmation
on the N4 Pro itself is outstanding.

### USEFUL v2 consolidated onto Context URL — `DONE` / `VERIFIED AUTOMATED` + `VERIFIED RUNTIME` / `WAITING PHYSICAL TESTING`

The point of the Context URL primitive was that adding a site should not require a new
plugin action. The live profile now demonstrates it.

**Live profile inventory** (host store, not the repo copy — the repo copy is stale and is
missing all three Context URL keys):
`%APPDATA%\HotSpot\StreamDock\profiles\19V6O19O-…sdProfile\profiles\F06684D5-…sdProfile\manifest.json`,
bound to `VSDN4Pro` serial `01E2D2782F04`. Ten of fifteen slots occupied; row 0 empty.

| Slot | Key | Before | After |
| --- | --- | --- | --- |
| 2,1 | IMDb | `…bridge.imdb` | **Context URL** `https://www.imdb.com/find?q={title}` |
| 3,1 | CAST | `…bridge.cast` | **Context URL** `https://www.google.com/search?q={title}%20cast` |
| 4,1 | JUSTWATCH | `…bridge.justwatch` | **Context URL** `https://www.justwatch.com/us/search?q={title}` |
| 0,2 | REDDIT | `…bridge.reddit` | **Context URL** `https://www.reddit.com/search/?q={title}` |
| 2,2 / 3,2 / 4,2 | Trailers / Rotten Tomatos / ReelGood | already Context URL | unchanged |
| 0,1 / 1,1 / 1,2 | AUDIO FIX / RECORD / TRANSCRIBE | specialized | **untouched** |

Seven of ten keys are now one generic action. **Nothing web-shaped needs a bespoke action
type any more.**

**Not converted, and why.** AUDIO FIX switches a Windows audio output device (a
third-party plugin holding a concrete endpoint in its settings). RECORD is a stateful OBS
start/stop toggle — a URL cannot hold a toggle. TRANSCRIBE reads the current tab but hands
it to TranscriptForge; opening a URL would not perform the transcription. Converting any
of these for uniformity would break them.

**Destinations are byte-identical.** Each migrated template was run through the same
resolver against the same live context and compared with its old built-in route:
all four match exactly, including CAST's literal `%20`, which the template engine passes
through untouched.

**Appearance is preserved deliberately.** Each migrated key keeps its original artwork and
its `Name`, and is migrated with `autoWebsiteIcon: false`. Turning auto-icon on would have
*downgraded* three of them — JustWatch publishes only 16×16 and 32×32, which is smaller
than the existing hand-made art. The mechanism changed; the look did not. The owner can
switch auto-icon on per key.

**Legacy actions kept, but hidden.** The four original UUIDs still ship and still dispatch,
so any other profile or installation keeps working. They are now marked
`"VisibleInActionsList": false` so they no longer appear in the action picker and nobody
creates new ones. That field is the host's own: it appears in `VSD Craft.exe`'s manifest
key table between `DisableCaching` and `UserTitleEnabled`, is read into a local
(`tmpVisibleInActionsList` in the PDB), and is already used by five shipped plugins. There
is no `Deprecated`/`Hidden`/`ShowInList` field anywhere in the host — this is the only such
mechanism, and a missing key defaults to visible, so it must be set explicitly.

Verified after a host restart: the profile still holds 7 Context URL bindings and 0 legacy
bindings, so VSD Craft accepted the migration rather than rewriting it.

### Context URL preset library — `DONE` / `VERIFIED AUTOMATED` / `WAITING RUNTIME + PHYSICAL TESTING`

Creating a common key should be easier than typing a URL. The Property Inspector gains an
optional **Preset** selector above the template field, grouped **Media** and **This page**,
with **Custom** as the default.

**A preset is sugar, and structurally cannot become anything else.** Choosing one writes a
normal `urlTemplate` into the key's settings and nothing more; the runtime executes that
template exactly as it would a hand-typed one. `presetId` is recorded only as provenance,
is *derived from* the template rather than the reverse, and is deleted the moment the
template stops matching — so an edited preset correctly falls back to Custom. Nothing in
the service or the plugin reads it. That is deliberate: the moment the runtime branched on
a preset id we would be hard-coding behaviour per site again, which is the thing Context
URL replaced.

**16 presets, every URL requested against the real site before being added:**

| Media | This page |
| --- | --- |
| IMDb · Trailer · Rotten Tomatoes · Metacritic · Letterboxd · TMDB · ReelGood · JustWatch · Reddit · Wikipedia · Cast · Soundtrack · Ending explained | Google this page title · Reddit this page title · YouTube this page title |

The four migrated built-ins appear as presets with their destinations byte-identical,
CAST's literal `%20` included.

**Project presets are deliberately absent.** GitHub / Vercel / Supabase presets need
project placeholders that do not exist yet, and shipping a preset that always fails would
be worse than not shipping it. See the project-context section below.

**One catalog, one guard.** The panel is a `file://` page and cannot import the service
module, so it carries its own copy. A test parses the copy out of the HTML and asserts it
equals the service catalog exactly, in order, so the two cannot drift. Further tests assert
every preset resolves to a valid http(s) URL against a real context, that Auto Website Icon
can derive a static origin for each one, that only approved placeholders are used, and that
the panel always writes `urlTemplate` and treats `presetId` as provenance only.

**Not yet seen running.** The preset selector has automated and structural verification but
has not been exercised in the live Property Inspector — the workstation was in active use
and the host window could not be driven reliably. Runtime and physical confirmation are
outstanding.

### Multi-browser context channels — `DONE` / `VERIFIED AUTOMATED` + `VERIFIED RUNTIME (service)` / `WAITING BROWSER + PHYSICAL TESTING`

Brave publishes what is being watched; Chrome publishes what is being worked on. Neither
can disturb the other.

**What was there before.** One global `ContextRecord`, replaced wholesale by whoever posted
last. The only guards were a timestamp comparison and an empty-title check — neither knows
who sent anything. There was no browser identity in the payload, the record or the wire; no
disconnect detection, TTL or heartbeat; and `tabId`/`windowId` were stored but never read.
The extension's manifest pins its `key`, so Brave and Chrome present the **same** extension
id and the same origin: the service could not tell them apart even in principle. Brave's
media only appeared sticky because Brave stops posting when unfocused and nothing else
overwrote it — adding Chrome breaks that immediately.

**Channels.** `media`, `page` and `project` are independent, each with its own owner. An
observation carries the installation id, a connection generation, a per-source sequence,
tab/window and an observation time — enough to be judged rather than believed. A media
observation cannot touch the page channel by construction.

**Installation identity.** Each browser profile generates a `browserInstanceId` once and
keeps it in `chrome.storage.local` — never `sync`, which would replicate one identity
across profiles and recreate the collision. It is **routing** identity only; the
`X-Bridge-Secret` gate still authorizes every write. `browserFamily` (Brave detected via
`navigator.brave.isBrave()`) is descriptive and routes nothing, so two Chrome profiles are
correctly two sources.

**Modes**, per installation: `MEDIA_BROWSER` (media only), `WORK_BROWSER` (page + project),
`HYBRID` (all three), `DISABLED` (nothing). Default is `HYBRID` so a single-browser user
keeps working without opening settings. A mode change releases channels the browser is no
longer entitled to.

**Brave media policy** — ownership follows *activation*, not focus, which is why the key
keeps working while the owner reads something else or leaves the browser entirely:
activating an eligible tab takes ownership; activating an unrelated tab changes nothing;
closing the owner falls back to the next most recent eligible tab; closing the last clears
the channel. Eligibility is evidence-based — `og:type` video, a schema.org screen-work
type, or a real `<video>` with a source or duration — rather than a host allowlist that
would need editing per service and still miss a self-hosted player.

**Chrome work policy** — `page` is the active tab of the last-focused window, and moves the
moment the tab changes. Losing OS focus does not erase it.

**Arbitration** is deterministic, never arrival order: mode eligibility first, then a stale
generation or sequence is refused, then a silent owner (90 s) forfeits, then more recent
user activity wins, with an id-based tie-break so the outcome cannot flap. Only the owner
may release a channel.

**Disconnect.** A browser closing cleanly calls `POST /sources/disconnect` and its channels
go at once; the TTL is the backstop for a crash. `heartbeatTick` asks whether the service
still knows *this installation* — the old recovery check asked whether the service had any
context at all, which stops working the moment two browsers publish because the answer is
almost never no.

**Backward compatibility.** `contextStore` is now a thin view over the channels (media,
falling back to page), so every existing consumer, route and test is untouched — all 584
tests pass with no call-site changes. An extension built before channels sends no source
and is treated as one HYBRID browser publishing media, exactly as before. Context URL gains
`contextMode` (`auto` | `media` | `page` | `project`); `auto` is media-then-page, so keys
configured before channels existed resolve against the same thing they always did.

**Observability.** `GET /contexts` shows each channel's owner and value; `GET /sources`
lists installations. Neither carries a secret. The extension gains a settings page showing
mode, name, which channels it publishes, and who currently owns each.

**Also fixed while here:** the client-supplied `timestamp` was unvalidated, so a poster
claiming a far-future time would wedge the legacy store permanently — it is now clamped to
the server clock.

**Proven against the running service** with two simulated installations: Brave media and
Chrome page coexisting; `mode_forbids_channel` refusing Chrome's media claim and Brave's
page claim; a media key resolving `Brickleberry` while Chrome published eight page updates;
and Brave's disconnect releasing only media.

#### FAILED PHYSICAL, 2026-08-30 — media key consumed the work browser's page

The owner ran the real two-browser test. Regular Show was playing in Brave; Chrome was in
front showing *"Emails | Authentication | Chrisyphus Ecosystem | cmarabate | Supabase"*.
Pressing the ReelGood key **searched the Supabase page title**.

Live state captured before any repair:

| | |
| --- | --- |
| Brave `76faa101…` | `MEDIA_BROWSER`, gen 4, connected 57 s ago |
| Chrome `7b9c4683…` | **`HYBRID`**, gen 2, connected |
| `media` | **NULL** |
| `page` | owned by Chrome |
| legacy `/context` | returned the Chrome page |

**Two independent defects**, both mine:

1. **Consumer — the visible failure.** Every Context URL key on the profile had no
   persisted `contextMode`, so all resolved as `auto`, and `auto` meant *media, then fall
   back to page*. With media empty it read Chrome's page. Backward compatibility had been
   implemented as a runtime fallback, which is exactly the cross-channel leak the channel
   model exists to prevent.
2. **Publisher — why media was empty.** Three faults compounded: the media tab tracker
   lives in an MV3 service worker the browser kills at will, and on the next call
   `publishMedia` published a *release* — Brave erasing its own channel; a content-script
   metadata timeout (150 ms, routinely missed by a heavy streaming page) was treated as
   "not media" and **deleted** the playing tab from the candidate set; and the heartbeat
   only did a `GET`, so a browser playing one episode quietly aged out at 90 s.

**Repairs.**

- `auto` now means *infer the channel from configuration*, never try channels until one has
  data. A "This page" preset resolves to `page`; everything else to `media`, because every
  Context URL key that existed before channels did was a media search. Explicit modes win.
- The legacy `contextStore` view is **media-only**. Absence of media is absence.
- Failure names the channel: `no_media_context` / `no_page_context` / `no_project_context`,
  and the key alerts instead of opening something wrong.
- `publishMedia` **rebuilds the candidate set from the real tabs** before concluding there
  is nothing playing; silence from a content script never demotes a tab; the metadata
  deadline is 600 ms.
- New `POST /sources/heartbeat` refreshes liveness **without** publishing, separating
  "source alive" from "context changed", and reports which channels the browser still owns
  so a service restart is noticed.
- **Arbitration now prefers a dedicated browser over a general one.** With Chrome left on
  the default `HYBRID`, a Chrome tab with a video would otherwise take media from the
  browser whose entire job is media. Saying what a browser is *for* settles it, not
  whichever tab was touched last.
- Every media key on the profile — and in the generator and validator — now persists
  `contextMode: media` explicitly rather than relying on a default. The plugin sends it and
  the Property Inspector exposes a **Context** selector.

**Runtime proof of the exact scenario**, against the live service: with Brave media
`Regular Show` and Chrome page the Supabase title, ReelGood resolved
`reelgood.com/search?q=Regular%20Show` and contained none of *Supabase / Emails /
Authentication / Chrisyphus*. With media removed and the Supabase page still present, the
same key returned **`no_media_context`** and launched nothing — both for an explicit
`media` key and for an `auto` one. With Brave dedicated and Chrome on `HYBRID`, Chrome's
media claim was refused as `lost_arbitration`.

**Adversarial review of the repair found three HIGH issues, all real, all reconciled.**

- `extractPageMetadata` only ever set `hasVideo: true`, never `false`, so an ordinary
  page's genuine reply was byte-identical to the content script never answering. The
  "only a real answer changes eligibility" guard therefore never fired, a media tab that
  navigated to a work page was never demoted, and `publishMedia` publishes the tab's LIVE
  title — reproducing the owner's failure *inside* the media channel, where isolation
  cannot help. `hasVideo` is now always set.
- The Property Inspector never restored `contextMode`: the restore had landed in the input
  handler rather than `applySettings`, so reopening a page key showed Auto and the next
  save — a Refresh Icon click sufficed — wrote that back, silently making it a media key.
- Two browsers on the default `HYBRID` could still fight over media by recency. A general
  browser may now **claim** a free channel but never **take** a live one.

Also reconciled: a heartbeat omitting `mode` defaulted to `DISABLED` and released every
channel the browser owned (now a bad request); `rebuildMediaTabs` scanned the first 40 tabs
in query order and broke ties by tab position, so a leftmost tab with any `<video>` could
win and a media tab past index 40 was invisible (active tabs are scanned and recorded
first); and both alarm callbacks could trigger a full tab scan every 30 s forever (rebuilds
are single-flight with a floor).

Transcribe reads media **then page** again — and that second look is safe there precisely
because `isSupportedTranscriptionUrl` refuses anything that is not a video platform. A
media *search* has no such guard, which is exactly why it must never fall back.

### Media recovery after extension reload — `DONE` / `VERIFIED AUTOMATED` + `VERIFIED RUNTIME` / `WAITING PHYSICAL RETEST`

**Physical reproduction evidence (owner confirmed on 2026-08-30):**
- Browser modes: Brave = `MEDIA_BROWSER`, Chrome = `WORK_BROWSER`. (Prior failure was NOT due to Chrome being `HYBRID`).
- **Strict channel isolation — PHYSICAL BEHAVIOR OBSERVED:**
  When Media was absent after reloading the extension, pressing a media Context URL key showed the yellow VSD warning / showAlert and opened nothing. It did NOT consume the Chrome Page channel. Strict fail-closed Media/Page isolation was physically proven.
- **Extension reload media recovery — FAILED PHYSICAL:**
  Media remained `none` until the owner refreshed ONLY the already-open Regular Show streaming page in Brave. Immediately after page refresh, Brave rediscovered the media and the media keys worked.
  **Conclusive root cause:** Chromium MV3 extension reload invalidates the content script `chrome.runtime` bridge in existing tabs, and declarative content scripts are not automatically re-injected into already-open tabs until those tabs reload.

**Repairs implemented:**
1. **Manifest permission**: Added `"scripting"` permission to `packages/extension/manifest.json`.
2. **Programmatic bootstrap recovery**: `requestMetadata` in `packages/extension/src/background.ts` attempts standard messaging (`GET_METADATA`). If messaging fails/times out on an eligible HTTP(S) URL, it programmatically injects `dist/content.js` via `chrome.scripting.executeScript({ target: { tabId }, files: ['dist/content.js'] })` and retries messaging.
3. **Idempotent content script listener**: `initContentScript` in `packages/extension/src/content.ts` guards registration via `window.__STREAM_DOCK_BRIDGE_CONTENT__.installedRuntimeId === chrome.runtime.id`, preventing duplicate listeners or event handlers across declarative and programmatic injections.
4. **Activation recency reconstruction**: `runRebuild` orders candidates with active tabs first, followed by non-active tabs sorted descending by `tab.lastAccessed`. Probing is strictly bounded to the top 40 candidates.
5. **Startup auto-rebuild**: `initExtension`, `chrome.runtime.onStartup`, and `chrome.runtime.onInstalled` trigger `rebuildMediaTabs(true)` for `MEDIA_BROWSER` and `HYBRID` modes, restoring media context immediately on extension reload without requiring page reload.
6. **Strict scheme security**: Non-scriptable schemes (`chrome://`, `brave://`, `edge://`, `devtools://`, `chrome-extension://`, `about:`, `file:`, and Chrome Web Store galleries) are strictly rejected before any script execution.

**Verification & Proof:**
- **Automated**: 681 tests / 34 test suites passing (`yarn test:ci`, `yarn verify:build`, `yarn verify:ts`, `yarn verify:lint`, `yarn build`, `yarn typecheck`, `yarn lint`, `git diff --check`).
- **Runtime**: Verified against live service (`127.0.0.1:17337`): simulated reload without page refresh reacquires Regular Show, Context URL lookups resolve to Regular Show in Chrome browser, and missing media fails closed with `no_media_context` / showAlert without falling back to Page.
- **Physical Retest Incident & Root Cause (2026-08-30)**:
  - *Observation*: With two streaming tabs open in Brave (*The Voyeurs* background + paused, *Regular Show* active + playing), pressing ReelGood after reload resolved *The Voyeurs*. Manually switching *The Voyeurs* -> *Regular Show* corrected ownership.
  - *Root Cause*: Bootstrap reconstruction previously assigned `order: 0` to all discovered tabs without playback awareness. In the candidate map, the first-discovered tab index (*The Voyeurs*) tied with the active playing tab (*Regular Show* at `0 > 0` = false), allowing a paused background tab to defeat the active playing tab.
  - *Repair*: Updated `extractPageMetadata` to detect active playback (`isPlaying`), and updated `MediaTabTracker` with a strict authority hierarchy:
    1. Active playing media in window (`isPlaying === true && isActive === true`)
    2. Background playing media (`isPlaying === true`)
    3. Active tab in window (`isActive === true`)
    4. Explicit live activation order (`order > 0`)
    5. Last accessed timestamp (`tab.lastAccessed`)
    6. Deterministic tie-breaker (`tabId`).
  - *Status*: `VERIFIED AUTOMATED` + `VERIFIED RUNTIME` / `WAITING OWNER PHYSICAL RETEST`.

### Project-aware Context URL & Closed Local Actions — `DONE` / `VERIFIED AUTOMATED` + `VERIFIED RUNTIME`

**The goal:** The same physical GITHUB / VERCEL / SUPABASE keys and local actions (Terminal, Folder, VS Code, Copy Path) open whichever project the owner is currently working in, without one key per project.

**1. Live ChatGPT Project & Work Page Extraction Contract:**
Live inspection established durable project signals from Chrome `WORK_BROWSER` pages:
- **ChatGPT Project URLs**: `https://(chatgpt.com|chat.openai.com)/g/g-p-<projectId>-<slug>(/c/<convId>)?` extracts stable `slug` (e.g. `oasis-culture-lounge`, `adhdeploy`, `ideaforge`).
- **ChatGPT Page Titles**: `"<Project Name> - <Conversation Title>"` or `"ChatGPT - <Project Name>"` (e.g. `"Oasis Culture Lounge - Reconcile StoryForge..."`).
- **GitHub URLs**: `https://github.com/<owner>/<repo>(/.*)?` extracts canonical `<owner>/<repo>`.
- **Vercel URLs**: `https://vercel.com/<team>/<project>(/.*)?`.
- **Related Domains**: Exact hostname matches against configured project domains.
- **Fail-Closed**: Generic or ambiguous pages (e.g. `google.com`, unrelated ChatGPT chats) evaluate to `project = null`.

**2. AgentOS Canonical Mapping (Read-Only):**
AgentOS remains the sole authority for project identity (`D:\_Dev\Apps\AgentOS\.agent-os\state\project-registry.json`, schema `project-registry-state-1`).
StreamDockBridge reads the registry read-only and maps extracted page evidence via a deterministic priority hierarchy:
1. `githubRepo` exact match (`owner/repo`)
2. `registryKey` exact match (slug)
3. `aliases` match (e.g. `"ChatGPT: GBC Lounge"` -> `gbc-lounge`)
4. `name` slugified / exact match (`"Oasis Culture Lounge"`)
5. Discovered project metadata / related domains

**3. Web Routing Metadata Discovery (Non-Secret):**
- Safely extracts `.vercel/project.json` (`orgId`, `projectId`, `projectName`) from `localRepoPath` when present.
- Never reads or exposes API keys, tokens, `.env` files, or database connection strings.

**4. Project Placeholders & Presets:**
- **Placeholders added**: `{projectName}`, `{githubOwner}`, `{githubRepo}`, `{vercelTeam}`, `{vercelProject}`, `{supabaseProjectRef}`, `{projectDomain}`.
- **Presets catalog**: Added `'Project'` group with verified templates for GitHub Repository, PRs, Issues, Actions, Vercel Project, Deployments, Supabase Project, SQL, Logs, and Production Website.
- **Strict Isolation**: `contextMode: 'project'` strictly consumes `contexts.project`. Missing project context or empty placeholder returns `400 {"error":"no_project_context"}` / `no_usable_context` -> `showAlert` on deck, never falling back to Page or Media.

**5. Closed Local Project Actions:**
- **Endpoint**: `POST /actions/local` (authenticated via `X-Bridge-Secret`).
- **Allowed intents**: `OPEN_PROJECT_TERMINAL`, `OPEN_PROJECT_FOLDER`, `OPEN_PROJECT_IN_VSCODE`, `COPY_PROJECT_PATH`.
- **Execution**: Direct binary execution via `child_process.spawn` (`wt.exe -d "<localRepoPath>"`, `explorer.exe "<localRepoPath>"`, `Code.exe "<localRepoPath>"`, PowerShell Set-Clipboard) without shell wrappers.
- **Security**: Target path is strictly resolved from AgentOS `localRepoPath`, validated for directory existence, and cannot be supplied by browser content or arbitrary strings.

**6. Two-Project Runtime Proof:**
- **Project A (`adhdeploy`)**: ChatGPT slug `adhdeploy` resolved to `cmarabate/adhdeploy` repo, Vercel team `team_9K2ORMlOEDhQq5G6KEWV4gHv`, and local path `D:\_Dev\Apps\adhdeploy`.
  - GitHub action opened `https://github.com/cmarabate/adhdeploy`.
  - Vercel action opened `https://vercel.com/team_9K2ORMlOEDhQq5G6KEWV4gHv/adhdeploy`.
  - Terminal action launched `wt.exe -d "D:\_Dev\Apps\adhdeploy"`.
- **Project B (`gbc-lounge` / Oasis Culture Lounge)**: ChatGPT slug `oasis-culture-lounge` resolved to `cmarabate/gbclounge.com` repo and local path `D:\_Dev\Websites\gbclounge.com`.
  - GitHub action opened `https://github.com/cmarabate/gbclounge.com`.
  - Terminal action launched `wt.exe -d "D:\_Dev\Websites\gbclounge.com"`.
- **Unrelated page (`google.com`)**: Returned `400 {"error":"no_project_context"}` and launched nothing.
- **Media independence**: Brave `MEDIA_BROWSER` remained on `Regular Show` throughout without cross-channel leakage.

**7. Windows Terminal & Copy Last Output Research:**
- Windows Terminal (`wt.exe`) installed at `%LOCALAPPDATA%\Microsoft\WindowsApps\wt.exe`.
- Supports native OSC 133 semantic marks (`133;A` prompt start, `133;B` command start, `133;C` output start, `133;D` exit code) and `copyLastOutput` action.
- Native clipboard copy of last command output requires terminal pane focus.
- **Status: `VERIFIED NATIVE TERMINAL CAPABILITY / NOT EXPOSED AS BACKGROUND STREAMDOCK ACTION`**.

**8. WatchDirector Architecture & Boundary:**
- Located read-only at `D:\_Dev\Apps\watchdirector` (Node.js 22.6 + SQLite ledger).
- Clear division of responsibility: StreamDockBridge owns browser Media source arbitration, raw Media observation, and N4 Deck routing; WatchDirector owns canonical media identity, watch history, metadata, and taste. WatchDirector code is preserved read-only without mutation.

**Status: `VERIFIED AUTOMATED` + `VERIFIED RUNTIME`.**

### Cross-Browser Voice Input → Media Auto-Pause & Pause Lease State Machine — `DONE` / `VERIFIED PHYSICAL` (core scenarios) + `VERIFIED AUTOMATED/RUNTIME`

**The goal:** When the owner begins ChatGPT voice dictation in Chrome (`WORK_BROWSER`), if the active Brave `MEDIA_BROWSER` is currently playing, StreamDockBridge automatically pauses Brave playback. When that same voice session ends, StreamDockBridge resumes the media session — unless the user has overridden playback or switched context.

**Owner Physical Acceptance Recorded (PASS - 2026-08-30):**
The owner performed real hardware/UI physical verification across Chrome ChatGPT and Brave streaming playback:
1. **ChatGPT microphone click start**: playing Brave media paused automatically (`VERIFIED PHYSICAL`).
2. **Ending Dictate**: the exact media StreamDockBridge paused resumed automatically (`VERIFIED PHYSICAL`).
3. **`Ctrl+Shift+D` keyboard shortcut**: produced the exact same voice lifecycle & pause/resume behavior (`VERIFIED PHYSICAL`).
4. **Media already paused before Dictate**: remained paused afterward; automation did not start playback (`VERIFIED PHYSICAL`).
5. **Context/media changes during Dictate**: automation did not resume or start the wrong media (`VERIFIED PHYSICAL`).

*Note on untested variants:* Stop / Send / Cancel transitions and 5-minute lease TTL expiration remain `VERIFIED AUTOMATED / VERIFIED RUNTIME`.

**1. Producer/Consumer Cross-Browser Architecture:**
- **Voice Lifecycle Producer**: Chrome (`WORK_BROWSER`) runs `ChatGPTVoiceObserver` mounted on `#prompt-textarea.closest('form')`. Detects active recording state via speech button / waveform DOM attributes.
- **Privacy Guarantee**: Zero audio recording, zero microphone stream interception, zero text/transcript character inspection. Emits discrete `VOICE_INPUT_STARTED` / `VOICE_INPUT_ENDED` events.
- **Media Controller Consumer**: Brave (`MEDIA_BROWSER`) runs `MediaPlaybackController` inside streaming tabs. Discovers active playing `<video>` across DOM/Shadow DOM using composite scoring (`!paused`, `currentTime > 0`, `readyState >= 2`, visible area, audible volume). Executes `PAUSE` and `RESUME` commands.

**2. Pause Lease Engine & State Machine (`VoiceCoordinator`):**
- **Explicit Pause Lease**: Instead of naive Start-Pause/End-Play pairing, the coordinator mints an explicit `PauseLease` on `VOICE_INPUT_STARTED` tracking `leaseId`, `voiceSessionId`, `mediaBrowserInstanceId`, `mediaTabId`, `mediaTitle`, and `expiresAt` (5-minute TTL).
- **Pre-Paused Media Protection**: If media was already paused before dictation started, `didPause = false` and the service will **never** resume playback when dictation ends (`VERIFIED PHYSICAL`).
- **Comprehensive User Override Coverage**: All play, pause, ended, emptied, error DOM events are captured. Spacebar, media keyboard keys, custom provider player controls, OS MediaSession overlays, and direct player state changes outside the programmatic window immediately invalidate resume authority (`overridden = true`) (`VERIFIED RUNTIME`).
- **Context Drift Protection**: If the media owner switches, or the media tab navigates or closes during dictation, the lease is invalidated and no resume command is sent (`VERIFIED PHYSICAL`).
- **Observability**: `GET /voice/status` returns live read-only state of the active voice session and media pause lease.
- **Configuration**: "Pause media while dictating" option exposed in extension settings.

**Status: `VERIFIED PHYSICAL` (for owner tested flows) + `VERIFIED AUTOMATED` + `VERIFIED RUNTIME`.**

### WatchDirector Cross-Repo Integration Mission (Specification) — `PLANNED` (Architectural Boundary Preserved)

StreamDockBridge and WatchDirector maintain strict separation of concerns:
- **StreamDockBridge** owns: raw HTML5 `<video>` observation across Chromium browsers, multi-browser source arbitration (`MEDIA_BROWSER` vs `WORK_BROWSER`), N4 Pro physical keypress handling, and local system actions.
- **WatchDirector** owns: canonical movie/show identity resolution, watch history ledger (`watchdirector.sqlite`), personal ratings, taste models, and cross-service availability.

**Next Cross-Repo Mission Requirements (for separate WatchDirector workspace)**:
1. Implement a lightweight local HTTP endpoint in WatchDirector (e.g. `POST /api/v1/observe/playback` on WatchDirector's loopback service).
2. Accept StreamDockBridge observation packets (`url`, `rawTitle`, `canonicalTitle`, `sourceIdentity`) authenticated via local handshake/token.
3. Perform idempotent title matching and update WatchDirector's live watch state without blocking StreamDockBridge deck response latency.
4. StreamDockBridge will never mutate WatchDirector database directly; all cross-repo communication will flow through this authenticated loopback API.

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
