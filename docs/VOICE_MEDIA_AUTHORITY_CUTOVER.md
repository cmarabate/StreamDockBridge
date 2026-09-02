# Voice / media authority cutover

## Decision

VoiceMediaBridge is the sole authority for voice-input lifecycle, current media identity/state, media pause ownership, media transport control, causal resume, and user-override semantics.

StreamDockBridge no longer owns or implements those behaviors.

## StreamDockBridge retained responsibilities

StreamDockBridge still owns its Stream Deck / VSD integration, browser and project context, local actions, lookup/transcription actions, button feedback, and browser URL/tab/window projection used by those features.

For media lookups, StreamDockBridge asks VoiceMediaBridge for the current GSMTC media projection and then applies its own canonical-title cleaner and destination-specific URL template. The streaming page DOM is not a fallback source of media identity.

The browser extension may still observe page metadata to locate and preserve browser context such as the current streaming URL. That observation is not authoritative for the media work title or playback state.

If VoiceMediaBridge cannot prove usable media identity for the same browser that owns StreamDockBridge's media channel, title-based Stream Deck actions fail closed instead of searching a plausible-looking site-chrome string.

## Removed StreamDockBridge authority

The cutover applies to the whole of StreamDockBridge, not just the content script.

The StreamDockBridge **content script** must not:

- detect ChatGPT Dictate or any voice-input lifecycle;
- send voice lifecycle events;
- issue page-level media Pause/Resume commands;
- maintain pause leases or user-override evidence;
- reconcile replacement video elements for transport control.

It may answer `GET_METADATA` with the existing read-only browser projection so StreamDockBridge URL/context features continue to work.

The StreamDockBridge **extension background worker** must not:

- persist or restore voice-session transport state;
- queue or forward voice lifecycle events to the service;
- forward media-override evidence;
- poll the service for media commands;
- validate or acknowledge media commands;
- dispatch `EXECUTE_MEDIA_COMMAND` to any tab.

It still observes `MEDIA_PLAYBACK_CHANGED` and republishes the Media context, because that is context observation, not transport.

The extension options page no longer offers a "Pause media while dictating" setting. The `pauseMediaWhileDictating` storage key it wrote was read by nothing after the cutover, and the control was removed on 2026-09-02 as cutover residue.

The StreamDockBridge **service** must not expose a voice or media transport protocol. The endpoints `POST /voice/lifecycle`, `GET /voice/status`, `GET /media/commands`, `POST /media/commands/validate`, `POST /media/commands/ack` and `POST /media/override`, and the `VoiceCoordinator` that backed them, were removed on 2026-09-01. Requests to those paths now 404.

## ContextBridge boundary

ContextBridge is the logical browser/current-context authority: browser role, current tab and window, page/project context publication, context channels, source TTL/heartbeat and arbitration.

ContextBridge is a **logical** boundary that remains **hosted inside the existing StreamDockBridge service and extension**. It is not a separate process, package, or repository, and extracting it into one is deliberately out of scope for this cleanup. Code must not assume that extraction has happened.

## Migration evidence

The cutover follows VoiceMediaBridge physical acceptance on the owner's Windows machine on 2026-09-01. The accepted VoiceMediaBridge path independently paused and causally resumed Brave media from ChatGPT Dictate with StreamDockBridge disabled, respected manual playback override, survived repeated ordinary-use checks, and continued working after automatic episode transitions.

The GSMTC context path was then promoted to media-identity authority after StreamDockBridge's page-derived title produced generic Disney+ site chrome instead of the actual show title.

The legacy transport was then removed. By that point it was already inert: nothing in the repository produced `VOICE_LIFECYCLE` and nothing implemented `EXECUTE_MEDIA_COMMAND`, so the background worker's command poller only generated continuous loopback traffic for a chain that could never execute.

## Safety rule

There must be one media authority. VoiceMediaBridge owns media identity/state and transport. StreamDockBridge consumes that read-only media truth for Stream Deck actions and retains browser URL/project/page context only.
