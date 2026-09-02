# ContextBridge logical boundary

Status: internal logical boundary hosted by StreamDockBridge.

ContextBridge is **not** a separate repository, daemon, registry, or localhost trust root. The existing StreamDockBridge service and browser extension host its current implementation while StreamDockBridge narrows toward VSD/N4 hardware authority.

## Authority

ContextBridge owns browser/application context publication, source arbitration, freshness, and read-only contextual projection.

AgentOS Project Registry is the sole project identity authority. ContextBridge must not become a second project resolver.

Therefore project identity is accepted only from an **exact AgentOS-owned binding**:

- exact `registryKey` validated against AgentOS identity state;
- exact `githubRepo` matched to an observed GitHub owner/repository;
- exact `relatedDomains` hostname match.

Duplicate exact bindings fail closed.

The following are non-authoritative and must never be promoted to identity by ContextBridge:

- ChatGPT project URL slugs;
- ChatGPT conversation/page titles;
- project names or slugified names;
- aliases;
- Vercel project-name inference;
- substring, fuzzy, or best-candidate matching.

AgentOS's alias/name read surface is candidate metadata only. A single candidate is still not authority.

Until AgentOS owns an explicit ChatGPT-project external binding, a ChatGPT project page that exposes no other exact declared binding has **no exact project context**. Failing closed is intentional.

## Existing state authority

`ContextChannelStore` remains the single channel state authority for:

- `media`;
- `page`;
- `project`.

The historical `ContextStore` is a compatibility view over the media channel, not a second database.

The versioned `ContextBridgeSnapshotV1` projection wraps the existing channel store and uses one read time for the entire snapshot. Expired channel owners are omitted rather than represented as fresh.

MEDIA continues to use VoiceMediaBridge/GSMTC as the authoritative media identity/playback overlay when configured. Browser media observations contribute browser URL/tab/window context; ContextBridge does not regain media-control authority.

## Enrichment

Non-secret local metadata such as Vercel project information or Supabase project reference may be read only **after** exact AgentOS identity has already been established. Enrichment must never participate in deciding which project the browser is showing.

## Process and transport

This boundary does not authorize:

- a standalone ContextBridge process;
- another port or secret;
- another browser extension/native host;
- another project registry;
- generic RPC.

E1 remains a later experiment: after this internal boundary is production-wired and proven, determine whether the current localhost service lifetime can safely be reduced or replaced by existing browser/native messaging infrastructure. Transport experimentation must not change authority semantics.

## Security

ContextBridge snapshots contain bounded context metadata only. They must not expose bridge secrets, credentials, cookies, arbitrary browser history, or page-body content.
