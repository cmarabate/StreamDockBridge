# Voice / media authority cutover

## Decision

VoiceMediaBridge is the sole authority for voice-input lifecycle, media pause ownership, media transport control, causal resume, and user-override semantics.

StreamDockBridge no longer owns or implements those behaviors.

## StreamDockBridge retained responsibilities

StreamDockBridge still owns its Stream Deck / VSD integration, browser and project context, local actions, lookup/transcription actions, button feedback, and read-only page/media metadata used by those features.

Read-only media context is intentionally retained. Knowing the current media title or whether a page appears to contain playing media is context; issuing Pause/Resume or coupling that state to ChatGPT Dictate is authority and belongs to VoiceMediaBridge.

## Removed extension authority

The StreamDockBridge content script must not:

- detect ChatGPT Dictate or any voice-input lifecycle;
- send voice lifecycle events;
- issue page-level media Pause/Resume commands;
- maintain pause leases or user-override evidence;
- reconcile replacement video elements for transport control.

It may answer `GET_METADATA` with the existing metadata projection so StreamDockBridge context features continue to work.

## Migration evidence

The cutover follows VoiceMediaBridge physical acceptance on the owner's Windows machine on 2026-09-01. The accepted VoiceMediaBridge path independently paused and causally resumed Brave media from ChatGPT Dictate with StreamDockBridge disabled, respected manual playback override, survived repeated ordinary-use checks, and continued working after automatic episode transitions.

## Safety rule

There must be one media-control owner. Re-enabling StreamDockBridge after this cleanup must not create a second Dictate/media controller. VoiceMediaBridge remains the sole writer for the behavior; StreamDockBridge is context-only with respect to browser media.
