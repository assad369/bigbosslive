# Local patches to flutter_webrtc

Upstream: `flutter_webrtc` **1.6.3** from pub.dev (the version `livekit_client` 2.13.2 resolves).
It is vendored without `example/` and wired in through `dependency_overrides` in
`app/pubspec.yaml`. Each patched spot is marked `[bigbosslive patch]`.

## Android: no exception may escape `onAddTrack` / `onRemoveTrack`

File: `android/src/main/java/com/cloudwebrtc/webrtc/PeerConnectionObserver.java`

**Crash.** On a Redmi (Android 16), viewers joining a live with two people on stage hit a
SIGABRT in `libjingle_peerconnection_so.so`, every frame native. Disassembling
WebRTC-SDK 150.7871.01 (BuildId `8939406b3b9fa259`) at the crashing frame shows the JNI
exception check after native WebRTC calls
`PeerConnection.Observer.onAddTrack(RtpReceiver, MediaStream[])`. A Java exception thrown in
that callback aborts the process.

**Cause.** `org.webrtc.PeerConnection.getTransceivers()` is unsynchronized and disposes the
wrappers it returned last time. `RtpReceiver.dispose()` then throws `IllegalStateException`
if a receiver is already disposed. flutter_webrtc calls it from two threads: `onAddTrack` (the
WebRTC signaling thread) and the main thread (`getTransceiversTrack` when a renderer binds a
track, Dart `getTransceivers`, `getNextTrackUUID`). The second remote track's `onAddTrack`
races the first track's renderer, and the signaling thread throws.

**Patch.**
- `onAddTrack` / `onRemoveTrack` delegate to the unchanged bodies (`addTrack` /
  `removeTrack`) inside `try { … } catch (Throwable)`, which logs.
- The unified-plan transceiver lookup in `addTrack` is best-effort. If it loses the race, the
  `onTrack` event is still sent without `transceiver`. LiveKit only reads `streams` and
  `track`.
- `getTransceiversTrack` returns `null` instead of throwing when it loses the race.
- No locks: `nativeGetTransceivers()` blocks on the signaling thread, so a main-thread lock
  held across it would deadlock against `onAddTrack`.

## Upgrading

1. Bump `livekit_client` in `app/pubspec.yaml` and see which `flutter_webrtc` it needs
   (`flutter pub deps`, with the override temporarily removed).
2. Re-copy that version here (`rsync -a --exclude example <pub-cache>/flutter_webrtc-X/ .`),
   re-apply the `[bigbosslive patch]` hunks, and update the version above.
3. Drop the override only once upstream `onAddTrack` / `onRemoveTrack` can't throw into
   native code.
