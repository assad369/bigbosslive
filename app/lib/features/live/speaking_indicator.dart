import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../../core/theme/bb_colors.dart';

/// Three bouncing bars while someone is speaking; nothing otherwise. Driven by LiveKit's
/// active-speaker updates (`LiveRoomController.speakers`), so the caller passes the bool.
///
/// The animation runs only while [active], so idle tiles cost nothing (and tests that
/// `pumpAndSettle` never wait on it).
class SpeakingBars extends StatefulWidget {
  const SpeakingBars({
    super.key,
    required this.active,
    this.size = 14,
    this.color = BBColors.goldLight,
  });
  final bool active;
  final double size;
  final Color color;

  @override
  State<SpeakingBars> createState() => _SpeakingBarsState();
}

class _SpeakingBarsState extends State<SpeakingBars>
    with SingleTickerProviderStateMixin {
  late final _anim = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 900),
  );

  @override
  void initState() {
    super.initState();
    if (widget.active) _anim.repeat();
  }

  @override
  void didUpdateWidget(SpeakingBars old) {
    super.didUpdateWidget(old);
    if (widget.active && !_anim.isAnimating) {
      _anim.repeat();
    } else if (!widget.active && _anim.isAnimating) {
      _anim.stop();
    }
  }

  @override
  void dispose() {
    _anim.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    if (!widget.active) return const SizedBox.shrink();
    final s = widget.size;
    return Semantics(
      label: 'Speaking',
      child: Container(
        width: s + 6,
        height: s + 6,
        padding: const EdgeInsets.all(3),
        decoration: const BoxDecoration(
          color: BBColors.scrim,
          shape: BoxShape.circle,
        ),
        child: AnimatedBuilder(
          animation: _anim,
          builder: (_, _) => Row(
            mainAxisAlignment: MainAxisAlignment.spaceEvenly,
            crossAxisAlignment: CrossAxisAlignment.center,
            children: [
              for (var i = 0; i < 3; i++)
                Container(
                  width: s / 6,
                  // Each bar is a phase-shifted sine between 35% and 100% of the height.
                  height:
                      s *
                      (0.35 +
                          0.65 *
                              (0.5 +
                                  0.5 *
                                      math.sin(
                                        (_anim.value + i / 3) * 2 * math.pi,
                                      ))),
                  decoration: BoxDecoration(
                    color: widget.color,
                    borderRadius: BorderRadius.circular(s / 12),
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }
}

/// A soft pulsing glow behind [child] (an avatar) while [active].
class SpeakingGlow extends StatefulWidget {
  const SpeakingGlow({
    super.key,
    required this.active,
    required this.child,
    this.color = BBColors.goldLight,
  });
  final bool active;
  final Widget child;
  final Color color;

  @override
  State<SpeakingGlow> createState() => _SpeakingGlowState();
}

class _SpeakingGlowState extends State<SpeakingGlow>
    with SingleTickerProviderStateMixin {
  late final _anim = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 1000),
  );

  @override
  void initState() {
    super.initState();
    if (widget.active) _anim.repeat(reverse: true);
  }

  @override
  void didUpdateWidget(SpeakingGlow old) {
    super.didUpdateWidget(old);
    if (widget.active && !_anim.isAnimating) {
      _anim.repeat(reverse: true);
    } else if (!widget.active && _anim.isAnimating) {
      _anim
        ..stop()
        ..value = 0;
    }
  }

  @override
  void dispose() {
    _anim.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => AnimatedBuilder(
    animation: _anim,
    child: widget.child,
    builder: (_, child) => DecoratedBox(
      decoration: BoxDecoration(
        shape: BoxShape.circle,
        boxShadow: widget.active
            ? [
                BoxShadow(
                  color: widget.color.withValues(
                    alpha: 0.55 - 0.25 * _anim.value,
                  ),
                  blurRadius: 10 + 10 * _anim.value,
                  spreadRadius: 2 + 6 * _anim.value,
                ),
              ]
            : const [],
      ),
      child: child,
    ),
  );
}
