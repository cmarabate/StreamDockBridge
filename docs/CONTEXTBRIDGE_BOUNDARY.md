# ContextBridge boundary (CB-0A)

Status: internal logical boundary hosted by StreamDockBridge.

ContextBridge is **not** a separate repository, process, port, secret, browser
extension, or localhost trust root. The existing StreamDockBridge service and
browser extension host it, and it is reached through one read-only route on the
service that already exists.

## Authority

ContextBridge owns **evidence**, and only evidence:

- browser/current-context observations — what a browser reported seeing;
- source identity — which browser installation said it, in which role, on which
  connection generation;
- freshness — when it was observed, how old that is now, and whether it is still
  within its owner's TTL;
- arbitration — which source currently owns a channel;
- read-only projection of the above as a versioned snapshot.

ContextBridge **never decides canonical project identity.** It does not produce,
imply, or contain an AgentOS `registryKey`. It derives no identity from:

- page or conversation titles;
- project names, aliases, or slugs;
- ChatGPT project ids, GPT ids, or conversation ids;
- GitHub or Vercel URLs;
- hostnames or related domains;
- local repository inspection.

What it publishes about a provider is an *external provider identifier reported
verbatim, with the proof that produced it*. Deciding whether that identifier
corresponds to a known project is a different authority's job, downstream of
this boundary.

`ProjectRegistryService` remains in the repository for existing legacy/hardware
behaviour outside the ContextBridge contract. No ContextBridge path imports it,
and `contextBridge.test.ts` fails if one ever does.

## Contract: `ContextSnapshotV1`

```
schemaVersion : 'contextbridge.snapshot.v1'
readAt        : number            — one read instant for the whole snapshot
sources       : ContextSourceV1[] — every source connected at readAt (CB-0A.1)
channels      : { media, page }   — each an evidence entry, or null
```

Each evidence entry is:

```
source      : { sourceInstanceId, browserFamily, displayName, role, connectionGeneration }
observation : { sequence, observedAt, ageMs, ttlMs, fresh: true }
page        : { url, hostname, rawTitle, documentTitle, tabId, windowId }
providerContext : discriminated evidence union | null
```

Notes on the fields that carry the boundary:

- **`role`** is the browser's declared publication role (its channel mode). It
  says what that browser may publish. ContextBridge makes **no claim about OS
  foreground, window focus, or HWND truth** — it does not have that information
  and does not pretend to.
- **`fresh` is always `true`.** An owner past its TTL, disconnected, or fenced
  out by a newer connection generation is omitted from the snapshot entirely,
  rather than represented as stale-but-present.
- **`readAt` is taken once.** Every channel's `ageMs` is measured against it, so
  two channels in one snapshot can never disagree about what time it is.
- **`page` is an allowlist, built by construction.** A field added to
  `ContextRecord` later cannot leak into a snapshot until it is named here.
- **MEDIA is the browser's observation**, read without the VoiceMediaBridge /
  GSMTC media-identity overlay. VoiceMediaBridge remains the media identity and
  playback authority for the surfaces that consume it; ContextBridge reports
  what the browser saw and does not restate or regain that verdict.
- There is **no `project` channel.** The service's PROJECT channel carries an
  AgentOS-derived registry key — that is identity, not evidence, and it is
  therefore outside this contract.

### Connected source inventory (CB-0A.1)

`sources` is the set of browser installations considered connected at `readAt`,
each in the same `ContextSourceV1` shape a channel's `source` uses, ordered by
`sourceInstanceId`.

- **Why it exists: ambiguity detection.** PAGE is the active tab of one
  installation's last-focused window, but a second installation of the same
  browser family — another Chrome profile — can be connected at the same
  instant and can republish during MV3 startup or recovery. `browserFamily` is
  descriptive only; two profiles are two sources. A downstream consumer that
  correlates OS foreground by browser family needs the full connected set to
  notice that the correlation is ambiguous and fail closed. It is inventory
  for that consumer, not a verdict.
- **All roles are listed**, `DISABLED` included. Which roles matter is the
  consumer's decision.
- **Only connected sources appear.** Disconnected, TTL-expired and superseded
  sources are omitted, by the same test that omits their channels. A restarted
  installation appears once, at its newest connection generation.
- **A channel's owner is always listed.** When `channels.page` or
  `channels.media` is present, its `source.sourceInstanceId` is an entry in
  `sources`, and channel evidence itself is unchanged.
- **No `lastSeen`**, no secret, no page content, no `registryKey`, no
  `ProjectContext`, no AgentOS data, no HWND, and no "current browser" field.
  Presence in the snapshot is the liveness statement; a second clock would only
  be able to disagree with `readAt`.
- **ContextBridge still does not know OS foreground and does not choose which
  browser is current.** It lists who is connected; a consumer decides what that
  means. `/sources` remains a service debug route and is **not** part of the
  consumer contract — the inventory lives inside the authenticated, versioned
  snapshot so a consumer never has to stitch two reads together.
- Additive within `contextbridge.snapshot.v1`: a v1 reader that ignores
  `sources` sees exactly what it saw before.

## Provider evidence: ChatGPT

The rules, in full:

- **Only the URL path `/g/g-p-.../` proves project scope.** Nothing else does.
- The **entire `g-p-…` path segment** is preserved byte-for-byte as
  `externalProjectId`. It is not normalized, lowercased, split, or slugified.
- The sibling shape `/g/g-<id>-<slug>` is a **custom GPT, not a project**, and
  does not match.
- An ordinary conversation `/c/<uuid>` is `scope: 'conversation'` — never a
  project.
- A ChatGPT page that is neither is `scope: 'none'`: a positive finding that the
  browser is on ChatGPT and demonstrably not in a project.
- **A title never proves scope.** The evidence reader takes no title parameter
  at all, so a page called "StreamDockBridge — roadmap" on an ordinary
  conversation URL yields conversation scope and no project id.
- `conversationId` and `projectDisplayLabel` are populated **only when the URL
  itself established them** — a UUID-shaped id in the path, and the slug half of
  the project segment verbatim — and each carries its own evidence tag.
- `externalProjectId` is an OpenAI-side identifier. **It never becomes AgentOS
  identity.**

Every provider variant is a discriminated union member carrying an `evidence`
object naming the proof and the exact path fragment it came from. A URL no rule
covers yields `null`.

## Preserved behaviour

The snapshot is a projection over the existing `ContextChannelStore`, so the
properties that store already guarantees continue to hold and are asserted
against the snapshot: connection-generation fencing, monotonic observation
sequence, stale/replay rejection, TTL and heartbeat liveness, deterministic
arbitration between competing sources, owner-only release and disconnect,
recovery after a browser restart republishes, and multi-browser isolation.

## Route

```
GET /contextbridge/v1/snapshot   →  { success: true, snapshot: ContextSnapshotV1 }
```

- On the **existing** service and the existing loopback port. No new port, no
  new secret, no new process.
- **Authenticated** with the existing bridge secret (`X-Bridge-Secret`) and
  subject to the existing pinned-origin policy, even though it only reads: the
  snapshot names every browser the owner has open and what each is looking at.
- Version is in the path so the contract can change without breaking a reader
  that pinned v1.
- Deliberately **not** `/context` or `/contexts`. Those remain exactly what they
  were; `/contexts` is the debug view of the channel store including PROJECT.

## Out of scope

This boundary does not authorize a standalone process, another port or secret,
another extension or native host, another project registry, generic RPC, process
launch, AgentOS mutation, or any action authority. Snapshots expose bounded
context metadata only — never bridge secrets, credentials, cookies, browser
history, or page-body content.

## Next (CB-0B)

Wire one real consumer to `GET /contextbridge/v1/snapshot` and let it own the
identity decision that ContextBridge refuses to make — mapping an
`externalProjectId` to a project through an explicit AgentOS-owned binding, so
that the mapping lives on the identity authority's side of this boundary rather
than inside ContextBridge.
