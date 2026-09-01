# Voice / media authority cutover

## Decision

VoiceMediaBridge is the sole authority for voice-input lifecycle, current media identity/state, media pause ownership, media transport control, causal resume, and user-override semantics.

StreamDockBridge no longer owns or implements those behaviors.

## StreamDockBridge retained responsibilities

StreamDockBridge still owns its Stream Deck / VSD integration, browser and project context, local actions, lookup/transcription actions, button feedback, and browser URL/tab/window projection used by those features.

For media lookups, StreamDockBridge asks VoiceMediaBridge for the current GSMTC media projection and then applies its own canonical-title cleaner and destination-specific URL template. The streaming page DOM is not a fallback source of media identity.

The browser extension may still observe page metadata to locate and preserve browser context such as the current streaming URL. That observation is not authoritative for the media work title or playback state.

If VoiceMediaBridge cannot prove usable media identity for the same browser that owns StreamDockBridge's media channel, title-based Stream Deck actions fail closed instead of searching a plausible-looking site-chrome string.

## Removed extension authority

The StreamDockBridge content script must not:

- detect ChatGPT Dictate or any voice-input lifecycle;
- send voice lifecycle events;
- issue page-level media Pause/Resume commands;
- maintain pause leases or user-override evidence;
- reconcile replacement video elements for transport control.

It may answer `GET_METADATA` with the existing read-only browser projection so StreamDockBridge URL/context features continue to work.

## Migration evidence

The cutover follows VoiceMediaBridge physical acceptance on the owner's Windows machine on 2026-09-01. The accepted VoiceMediaBridge path independently paused and causally resumed Brave media from ChatGPT Dictate with StreamDockBridge disabled, respected manual playback override, survived repeated ordinary-use checks, and continued working after automatic episode transitions.

The GSMTC context path was then promoted to media-identity authority after StreamDockBridge's page-derived title produced generic Disney+ site chrome instead of the actual show title.

## Safety rule

There must be one media authority. VoiceMediaBridge owns media identity/state and transport. StreamDockBridge consumes that read-only media truth for Stream Deck actions and retains browser URL/project/page context only.
