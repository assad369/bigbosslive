import 'dart:async';

import 'package:cached_network_image/cached_network_image.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:livekit_client/livekit_client.dart';

import '../../core/platform/pip_service.dart';
import '../../core/providers.dart';
import '../../core/router/app_router.dart';
import '../../core/theme/bb_colors.dart';
import '../../core/utils/format.dart';
import '../../core/widgets/widgets.dart';
import '../../models/models.dart';
import 'active_live.dart';
import 'live_dialogs.dart';
import 'live_room_controller.dart';

/// Wraps the app (via `MaterialApp.builder`, above the Navigator) with what a live
/// session needs on every route: the floating mini-player, the Android PiP view and
/// PK invites. Dialogs go through the router's navigator, since this sits above it.
class LiveOverlayHost extends ConsumerStatefulWidget {
  const LiveOverlayHost({super.key, required this.child});
  final Widget child;

  @override
  ConsumerState<LiveOverlayHost> createState() => _LiveOverlayHostState();
}

class _LiveOverlayHostState extends ConsumerState<LiveOverlayHost> {
  LiveRoomController? _watched;
  StreamSubscription<PkBattle>? _invites;

  BuildContext? get _navContext =>
      ref.read(routerProvider).routerDelegate.navigatorKey.currentContext;

  /// One PK-invite subscription per session, whether full screen or minimized.
  void _watch(LiveRoomController? c) {
    if (identical(c, _watched)) return;
    unawaited(_invites?.cancel());
    _watched = c;
    _invites = c?.pkInvites.listen((battle) {
      final ctx = _navContext;
      if (ctx != null && ctx.mounted) {
        unawaited(showPkInviteDialog(ctx, ref.read(liveRepo), battle));
      }
    });
  }

  @override
  void dispose() {
    unawaited(_invites?.cancel());
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final active = ref.watch(activeLiveProvider);
    _watch(active?.controller);
    return ValueListenableBuilder<bool>(
      valueListenable: ref.watch(pipServiceProvider).inPip,
      child: widget.child,
      builder: (context, inPip, child) {
        final c = active?.controller;
        final pip = inPip && c != null;
        // The app stays first and mounted in every state so navigation survives.
        return Stack(
          fit: StackFit.expand,
          children: [
            Visibility(visible: !pip, maintainState: true, child: child!),
            if (pip)
              LiveThumbnail(c: c, large: true)
            else if (active != null && active.minimized)
              MiniLivePlayer(
                key: ValueKey(active.roomId),
                c: active.controller,
                onExpand: () =>
                    ref.read(routerProvider).push('/live/${active.roomId}'),
                onClose: () => _close(active.controller),
              ),
          ],
        );
      },
    );
  }

  Future<void> _close(LiveRoomController c) async {
    final notifier = ref.read(activeLiveProvider.notifier);
    if (!c.isHost) return notifier.close();
    final ctx = _navContext;
    if (ctx == null || !await confirmEndLive(ctx)) return;
    final summary = await notifier.endHosting();
    final after = _navContext;
    if (after != null && after.mounted) await showLiveSummary(after, summary);
  }
}

/// Draggable floating window for a minimized live. Snaps to the nearest side and stays
/// clear of the status bar and bottom navigation.
class MiniLivePlayer extends ConsumerStatefulWidget {
  const MiniLivePlayer({
    super.key,
    required this.c,
    required this.onExpand,
    required this.onClose,
  });
  final LiveRoomController c;
  final VoidCallback onExpand;
  final VoidCallback onClose;

  static const size = Size(108, 192);
  static const _margin = 12.0;

  @override
  ConsumerState<MiniLivePlayer> createState() => _MiniLivePlayerState();
}

class _MiniLivePlayerState extends ConsumerState<MiniLivePlayer> {
  Offset? _pos;
  bool _dragging = false;

  Rect _bounds(MediaQueryData mq) {
    const s = MiniLivePlayer.size;
    const m = MiniLivePlayer._margin;
    final p = mq.padding;
    return Rect.fromLTRB(
      p.left + m,
      p.top + m,
      mq.size.width - p.right - m - s.width,
      mq.size.height - p.bottom - kBottomNavigationBarHeight - m - s.height,
    );
  }

  Offset _clamp(Offset o, Rect b) => Offset(
    o.dx.clamp(b.left, b.right < b.left ? b.left : b.right),
    o.dy.clamp(b.top, b.bottom < b.top ? b.top : b.bottom),
  );

  Offset _snap(Offset o, Rect b, double width) {
    final toRight = o.dx + MiniLivePlayer.size.width / 2 > width / 2;
    return _clamp(Offset(toRight ? b.right : b.left, o.dy), b);
  }

  @override
  Widget build(BuildContext context) {
    final mq = MediaQuery.of(context);
    final b = _bounds(mq);
    final notifier = ref.read(activeLiveProvider.notifier);
    final pos = _clamp(
      _pos ?? notifier.miniPosition ?? Offset(b.right, b.bottom),
      b,
    );
    return AnimatedPositioned(
      duration: _dragging ? Duration.zero : const Duration(milliseconds: 220),
      curve: Curves.easeOutCubic,
      left: pos.dx,
      top: pos.dy,
      width: MiniLivePlayer.size.width,
      height: MiniLivePlayer.size.height,
      child: Semantics(
        container: true,
        button: true,
        label: 'Live mini player. Double tap to return to the live.',
        child: GestureDetector(
          onTap: widget.onExpand,
          onPanStart: (_) => setState(() {
            _dragging = true;
            _pos = pos;
          }),
          onPanUpdate: (d) => setState(() => _pos = (_pos ?? pos) + d.delta),
          onPanEnd: (_) => setState(() {
            _dragging = false;
            _pos = _snap(_pos ?? pos, b, mq.size.width);
            notifier.miniPosition = _pos;
          }),
          child: DecoratedBox(
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(14),
              boxShadow: const [
                BoxShadow(
                  color: BBColors.scrim,
                  blurRadius: 16,
                  offset: Offset(0, 6),
                ),
              ],
            ),
            child: ClipRRect(
              borderRadius: BorderRadius.circular(14),
              child: Stack(
                fit: StackFit.expand,
                children: [
                  LiveThumbnail(c: widget.c),
                  Positioned(
                    top: 2,
                    right: 2,
                    child: Semantics(
                      button: true,
                      label: widget.c.isHost ? 'End live' : 'Close live',
                      child: GestureDetector(
                        onTap: widget.onClose,
                        behavior: HitTestBehavior.opaque,
                        child: const Padding(
                          padding: EdgeInsets.all(4),
                          child: _RoundIcon(Icons.close_rounded),
                        ),
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// What a live looks like when small: the host's video, or for audio rooms and while
/// video is missing, the cover with the host's avatar. [large] is the Android PiP window.
class LiveThumbnail extends StatelessWidget {
  const LiveThumbnail({super.key, required this.c, this.large = false});
  final LiveRoomController c;
  final bool large;

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: c,
    builder: (context, _) {
      final room = c.detail?.room;
      final video = room == null || room.isAudio ? null : c.hostVideo;
      final cover = room?.coverUrl;
      return ColoredBox(
        color: BBColors.espresso,
        child: Stack(
          fit: StackFit.expand,
          children: [
            if (video != null)
              VideoTrackRenderer(
                video,
                fit: VideoViewFit.cover,
                mirrorMode: c.isHost && c.frontCamera
                    ? VideoViewMirrorMode.mirror
                    : VideoViewMirrorMode.off,
              )
            else ...[
              if (cover != null)
                CachedNetworkImage(
                  imageUrl: cover,
                  fit: BoxFit.cover,
                  color: BBColors.scrim,
                  colorBlendMode: BlendMode.darken,
                  errorWidget: (_, _, _) => const SizedBox.shrink(),
                ),
              if (room != null)
                Center(
                  child: _SpeakingAvatar(c: c, host: room.host, large: large),
                ),
            ],
            if (room == null && c.status == LiveStatus.connecting)
              const Center(
                child: SizedBox.square(
                  dimension: 22,
                  child: CircularProgressIndicator(strokeWidth: 2),
                ),
              ),
            Positioned(
              left: 6,
              top: 6,
              child: _Pill(
                color: BBColors.danger,
                child: Text(
                  c.status == LiveStatus.reconnecting ? '•••' : 'LIVE',
                  style: _pillText,
                ),
              ),
            ),
            if (room != null)
              Positioned(
                left: 6,
                bottom: 6,
                child: _Pill(
                  color: BBColors.scrim,
                  child: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      const Icon(
                        Icons.visibility_rounded,
                        size: 11,
                        color: BBColors.ivory,
                      ),
                      const SizedBox(width: 3),
                      Text(Fmt.compact(c.viewerCount), style: _pillText),
                    ],
                  ),
                ),
              ),
            if (c.isHost && !c.micOn)
              const Positioned(
                right: 6,
                bottom: 6,
                child: _RoundIcon(Icons.mic_off_rounded),
              ),
          ],
        ),
      );
    },
  );
}

class _SpeakingAvatar extends StatelessWidget {
  const _SpeakingAvatar({
    required this.c,
    required this.host,
    required this.large,
  });
  final LiveRoomController c;
  final UserBrief host;
  final bool large;

  @override
  Widget build(BuildContext context) {
    final speaking = c.isSpeaking(host.id);
    return AnimatedContainer(
      duration: const Duration(milliseconds: 200),
      padding: const EdgeInsets.all(3),
      decoration: BoxDecoration(
        shape: BoxShape.circle,
        border: Border.all(
          color: speaking ? BBColors.gold : BBColors.ivory.withValues(alpha: 0),
          width: 2,
        ),
      ),
      child: BBAvatar(
        url: host.avatarUrl,
        name: host.displayName,
        size: large ? 72 : 48,
      ),
    );
  }
}

const _pillText = TextStyle(
  color: BBColors.ivory,
  fontSize: 10,
  fontWeight: FontWeight.w800,
);

class _Pill extends StatelessWidget {
  const _Pill({required this.color, required this.child});
  final Color color;
  final Widget child;

  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
    decoration: BoxDecoration(
      color: color,
      borderRadius: BorderRadius.circular(8),
    ),
    child: child,
  );
}

class _RoundIcon extends StatelessWidget {
  const _RoundIcon(this.icon);
  final IconData icon;

  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.all(3),
    decoration: const BoxDecoration(
      color: BBColors.scrim,
      shape: BoxShape.circle,
    ),
    child: Icon(icon, size: 14, color: BBColors.ivory),
  );
}
