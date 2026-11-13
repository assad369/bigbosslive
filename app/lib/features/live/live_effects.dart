import 'dart:async';

import 'package:flutter/material.dart';

import '../../core/theme/bb_colors.dart';
import '../../core/widgets/frame_view.dart';
import '../../core/widgets/widgets.dart';
import '../../models/models.dart';
import 'live_room_controller.dart';

/// Slides in "Name entered" for VIP / entrance-effect arrivals, one at a time, in the
/// arrival's tier colours (VIP purple, VVIP gold, King crimson).
class EntryBanner extends StatefulWidget {
  const EntryBanner({super.key, required this.entries});
  final Stream<EntryEvent> entries;

  @override
  State<EntryBanner> createState() => _EntryBannerState();
}

class _EntryBannerState extends State<EntryBanner> {
  final _queue = <UserBrief>[];
  UserBrief? _current;
  StreamSubscription<EntryEvent>? _sub;
  Timer? _hide;

  @override
  void initState() {
    super.initState();
    _sub = widget.entries.listen((e) {
      // Keep the queue short in busy rooms.
      if (_queue.length < 5) _queue.add(e.user);
      _next();
    });
  }

  void _next() {
    if (_current != null || _queue.isEmpty) return;
    setState(() => _current = _queue.removeAt(0));
    _hide = Timer(const Duration(milliseconds: 2600), () {
      if (!mounted) return;
      setState(() => _current = null);
      Timer(const Duration(milliseconds: 350), () {
        if (mounted) _next();
      });
    });
  }

  @override
  void dispose() {
    unawaited(_sub?.cancel());
    _hide?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final u = _current;
    return IgnorePointer(
      child: AnimatedSwitcher(
        duration: const Duration(milliseconds: 350),
        transitionBuilder: (child, a) => SlideTransition(
          position: Tween(
            begin: const Offset(-1.2, 0),
            end: Offset.zero,
          ).animate(a),
          child: child,
        ),
        child: u == null
            ? const SizedBox.shrink()
            : Container(
                key: ValueKey(u.id),
                padding: const EdgeInsets.fromLTRB(4, 4, 14, 4),
                decoration: BoxDecoration(
                  gradient:
                      BBColors.tierGradient(u.vipTier) ?? BBColors.goldGradient,
                  borderRadius: BorderRadius.circular(20),
                  border: Border.all(color: BBColors.goldLight, width: 0.8),
                  boxShadow: [
                    BoxShadow(
                      color: BBColors.tierColor(u.vipTier)
                          .withValues(alpha: 0.5),
                      blurRadius: 12,
                    ),
                  ],
                ),
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    BBAvatar.user(u, size: 26, ring: true),
                    const SizedBox(width: 6),
                    if (u.vipTier > 0) ...[
                      VipBadge(u.vipTier, dense: true),
                      const SizedBox(width: 4),
                    ],
                    LevelBadge(u.level, dense: true),
                    const SizedBox(width: 6),
                    Flexible(
                      child: Text(
                        '${u.displayName} entered',
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(
                          color: u.vipTier > 0
                              ? BBColors.onAccent
                              : BBColors.ink,
                          fontWeight: FontWeight.w800,
                          fontSize: 12,
                        ),
                      ),
                    ),
                  ],
                ),
              ),
      ),
    );
  }
}

/// Full-screen entrance effects (SVGA, Lottie or MP4), one at a time. Arrivals without an
/// effect get only the [EntryBanner]. The queue is capped so a busy room never backs up.
class EntryEffectOverlay extends StatefulWidget {
  const EntryEffectOverlay({
    super.key,
    required this.entries,
    this.muted = false,
  });
  final Stream<EntryEvent> entries;

  /// The viewer silenced the room (speaker off): effects play without sound.
  final bool muted;

  @override
  State<EntryEffectOverlay> createState() => _EntryEffectOverlayState();
}

class _EntryEffectOverlayState extends State<EntryEffectOverlay> {
  final _queue = <EntryEvent>[];
  EntryEvent? _current;
  int _seq = 0;
  StreamSubscription<EntryEvent>? _sub;

  @override
  void initState() {
    super.initState();
    _sub = widget.entries.listen((e) {
      if (e.effectUrl == null || e.effectUrl!.isEmpty) return;
      if (_queue.length < 5) _queue.add(e);
      _next();
    });
  }

  void _next() {
    if (_current != null || _queue.isEmpty || !mounted) return;
    setState(() {
      _current = _queue.removeAt(0);
      _seq++;
    });
  }

  void _done() {
    if (!mounted) return;
    setState(() => _current = null);
    _next();
  }

  @override
  void dispose() {
    unawaited(_sub?.cancel());
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final e = _current;
    if (e == null) return const SizedBox.shrink();
    return IgnorePointer(
      child: EffectView(
        key: ValueKey(_seq),
        url: e.effectUrl!,
        format: e.effectFormat,
        sound: !widget.muted,
        onDone: _done,
      ),
    );
  }
}
