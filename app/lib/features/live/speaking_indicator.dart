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

/// Rings rippling out from [child] (a round avatar) while [active]: the speaking cue on a
/// stage tile whose camera is off.
///
/// Only the paint layer redraws each frame ([CustomPaint] repaints from the animation), so
/// the avatar under it is never rebuilt. The tree has the same shape whether or not the
/// person is speaking, so toggling never remounts (and reloads) the avatar. With the system
/// "remove animations" setting on, a still ring shows instead.
class SpeakingWave extends StatefulWidget {
  const SpeakingWave({
    super.key,
    required this.active,
    required this.child,
    this.color = BBColors.liveRed,
  });
  final bool active;
  final Widget child;
  final Color color;

  @override
  State<SpeakingWave> createState() => _SpeakingWaveState();
}

class _SpeakingWaveState extends State<SpeakingWave>
    with SingleTickerProviderStateMixin {
  late final _anim = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 1600),
  );
  bool _calm = false;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _calm = MediaQuery.maybeDisableAnimationsOf(context) ?? false;
    _sync();
  }

  @override
  void didUpdateWidget(SpeakingWave old) {
    super.didUpdateWidget(old);
    _sync();
  }

  void _sync() {
    final run = widget.active && !_calm;
    if (run && !_anim.isAnimating) {
      _anim.repeat();
    } else if (!run && _anim.isAnimating) {
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
  Widget build(BuildContext context) => RepaintBoundary(
    child: CustomPaint(
      painter: _SpeakingWavePainter(
        progress: _anim,
        color: widget.color,
        active: widget.active,
        calm: _calm,
      ),
      child: widget.child,
    ),
  );
}

/// Paints [SpeakingWave]: a solid ring hugging the avatar plus [waves] rings that grow
/// outward to [reach] × its radius and fade. Paints nothing while inactive.
class _SpeakingWavePainter extends CustomPainter {
  _SpeakingWavePainter({
    required this.progress,
    required this.color,
    required this.active,
    required this.calm,
  }) : super(repaint: progress);

  final Animation<double> progress;
  final Color color;
  final bool active;

  /// Reduced motion: one still outer ring instead of the moving ones.
  final bool calm;

  static const waves = 3;
  static const reach = 1.45;

  @override
  void paint(Canvas canvas, Size size) {
    if (!active || size.isEmpty) return;
    final center = size.center(Offset.zero);
    final r0 = size.shortestSide / 2;
    final paint = Paint()
      ..style = PaintingStyle.stroke
      ..isAntiAlias = true;

    // Just outside the avatar's edge, so it never covers the photo.
    canvas.drawCircle(
      center,
      r0 + 1,
      paint
        ..color = color
        ..strokeWidth = 2,
    );

    if (calm) {
      canvas.drawCircle(
        center,
        r0 * 1.2,
        paint
          ..color = color.withValues(alpha: 0.35)
          ..strokeWidth = 1.5,
      );
      return;
    }
    for (var i = 0; i < waves; i++) {
      final t = (progress.value + i / waves) % 1;
      final grow = Curves.easeOut.transform(t);
      canvas.drawCircle(
        center,
        r0 + 2 + r0 * (reach - 1) * grow,
        paint
          ..color = color.withValues(alpha: 0.7 * (1 - t))
          ..strokeWidth = 2.5 - 1.5 * t,
      );
    }
  }

  @override
  bool shouldRepaint(_SpeakingWavePainter old) =>
      old.active != active ||
      old.calm != calm ||
      old.color != color ||
      old.progress != progress;
}
