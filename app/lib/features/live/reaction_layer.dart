import 'dart:async';
import 'dart:math' as math;
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/scheduler.dart';

import '../../core/theme/bb_colors.dart';
import '../../models/models.dart';
import 'live_room_controller.dart';

/// Emoji reactions floating up from the reaction button.
///
/// Built for reaction storms: one [Ticker], one repaint per frame and a single `drawAtlas`
/// call for every particle (the emoji are rasterised once into a sprite sheet). At most
/// [_maxParticles] are alive; the oldest give way first. Purely decorative, so it never
/// takes touches.
class ReactionLayer extends StatefulWidget {
  const ReactionLayer({
    super.key,
    required this.reactions,
    required this.anchorKey,
  });
  final Stream<ReactionShow> reactions;

  /// The reaction button: particles start just above its centre.
  final GlobalKey anchorKey;

  @override
  State<ReactionLayer> createState() => _ReactionLayerState();
}

class _ReactionLayerState extends State<ReactionLayer>
    with SingleTickerProviderStateMixin {
  static const _maxParticles = 60;

  /// Sprite cell edge in logical pixels (the largest particle is ~36dp at its overshoot).
  static const _cell = 48.0;

  final _particles = <_Particle>[];
  final _clock = Stopwatch()..start();
  final _frame = ValueNotifier<int>(0);
  final _random = math.Random();
  late final Ticker _ticker;
  late final StreamSubscription<ReactionShow> _sub;
  ui.Image? _atlas;
  double _atlasDpr = 0;

  @override
  void initState() {
    super.initState();
    _ticker = createTicker(_tick);
    _sub = widget.reactions.listen(_spawn);
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final dpr = MediaQuery.devicePixelRatioOf(context);
    if (dpr != _atlasDpr) {
      _atlasDpr = dpr;
      _atlas?.dispose();
      _atlas = _buildAtlas(dpr);
    }
  }

  @override
  void dispose() {
    unawaited(_sub.cancel());
    _ticker.dispose();
    _frame.dispose();
    _atlas?.dispose();
    super.dispose();
  }

  /// Every reaction side by side, one [_cell] square each, at device resolution.
  static ui.Image _buildAtlas(double dpr) {
    final px = (_cell * dpr).ceilToDouble();
    final recorder = ui.PictureRecorder();
    final canvas = Canvas(recorder);
    for (final r in LiveReaction.values) {
      final tp = TextPainter(
        text: TextSpan(
          text: r.emoji,
          style: TextStyle(fontSize: px * 0.78, height: 1),
        ),
        textDirection: TextDirection.ltr,
      )..layout();
      tp.paint(
        canvas,
        Offset(r.index * px + (px - tp.width) / 2, (px - tp.height) / 2),
      );
      tp.dispose();
    }
    final picture = recorder.endRecording();
    final image = picture.toImageSync(
      (px * LiveReaction.values.length).toInt(),
      px.toInt(),
    );
    picture.dispose();
    return image;
  }

  double get _now => _clock.elapsedMicroseconds / 1e6;

  void _spawn(ReactionShow show) {
    if (!mounted) return;
    final box = context.findRenderObject() as RenderBox?;
    if (box == null || !box.hasSize) return;
    final anchor =
        widget.anchorKey.currentContext?.findRenderObject() as RenderBox?;
    // The button is gone on the narrowest phones and while typing: start roughly where
    // it would be.
    final origin = anchor != null && anchor.attached && anchor.hasSize
        ? box.globalToLocal(
                anchor.localToGlobal(anchor.size.center(Offset.zero)),
              ) -
              const Offset(0, 28)
        : Offset(box.size.width - 34, box.size.height - 90);
    final calm = MediaQuery.disableAnimationsOf(context);
    final n = show.count.clamp(1, 10);
    final now = _now;
    for (var i = 0; i < n; i++) {
      if (_particles.length >= _maxParticles) _particles.removeAt(0);
      _particles.add(
        _Particle(
          sprite: show.type.index,
          origin: origin,
          // Spread a burst over ~0.4 s so ten reactions read as a stream, not a blob.
          born: now + i * math.min(0.08, 0.4 / n),
          life: 2.2 + _random.nextDouble() * 0.5,
          size: (show.mine ? 34.0 : 28.0) + _random.nextDouble() * 4,
          rise: (calm ? 140.0 : 260.0) + _random.nextDouble() * 80,
          // Lean left: the button sits at the right edge of the screen.
          drift: -50 + _random.nextDouble() * 50,
          sway: calm ? 0 : 10 + _random.nextDouble() * 14,
          phase: _random.nextDouble() * math.pi * 2,
        ),
      );
    }
    if (!_ticker.isActive) unawaited(_ticker.start());
  }

  void _tick(Duration _) {
    final now = _now;
    _particles.removeWhere((p) => now - p.born >= p.life);
    if (_particles.isEmpty) _ticker.stop();
    _frame.value++;
  }

  @override
  Widget build(BuildContext context) => IgnorePointer(
    child: RepaintBoundary(
      child: CustomPaint(
        size: Size.infinite,
        painter: _ReactionPainter(
          particles: _particles,
          atlas: _atlas,
          cellPx: (_cell * _atlasDpr).ceilToDouble(),
          now: () => _now,
          repaint: _frame,
        ),
      ),
    ),
  );
}

class _Particle {
  _Particle({
    required this.sprite,
    required this.origin,
    required this.born,
    required this.life,
    required this.size,
    required this.rise,
    required this.drift,
    required this.sway,
    required this.phase,
  });
  final int sprite;
  final Offset origin;
  final double born, life, size, rise, drift, sway, phase;
}

class _ReactionPainter extends CustomPainter {
  _ReactionPainter({
    required this.particles,
    required this.atlas,
    required this.cellPx,
    required this.now,
    required super.repaint,
  });
  final List<_Particle> particles;
  final ui.Image? atlas;
  final double cellPx;
  final double Function() now;

  @override
  void paint(Canvas canvas, Size size) {
    final atlas = this.atlas;
    if (atlas == null || particles.isEmpty) return;
    final t = now();
    final transforms = <RSTransform>[];
    final rects = <Rect>[];
    final colors = <Color>[];
    for (final p in particles) {
      final f = (t - p.born) / p.life;
      if (f < 0 || f >= 1) continue;
      final y = p.origin.dy - p.rise * (1 - math.pow(1 - f, 1.6));
      final x =
          p.origin.dx +
          p.drift * f +
          math.sin(p.phase + f * math.pi * 2.4) * p.sway * math.min(1, f * 4);
      // Pop in with a small overshoot, then hold; fade out over the last 35%.
      final pop =
          0.4 + 0.6 * Curves.easeOutBack.transform(math.min(1, f / 0.18));
      final alpha =
          math.min(1.0, f / 0.05) * (f < 0.65 ? 1 : 1 - (f - 0.65) / 0.35);
      final scale = p.size * pop / cellPx;
      transforms.add(
        RSTransform.fromComponents(
          rotation: math.sin(p.phase + f * math.pi * 1.6) * 0.18,
          scale: scale,
          anchorX: cellPx / 2,
          anchorY: cellPx / 2,
          translateX: x,
          translateY: y,
        ),
      );
      rects.add(Rect.fromLTWH(p.sprite * cellPx, 0, cellPx, cellPx));
      // White modulates nothing; only the alpha fades the sprite.
      colors.add(BBColors.surface.withValues(alpha: alpha.clamp(0, 1)));
    }
    if (transforms.isEmpty) return;
    canvas.drawAtlas(
      atlas,
      transforms,
      rects,
      colors,
      BlendMode.modulate,
      null,
      Paint()..filterQuality = FilterQuality.medium,
    );
  }

  @override
  bool shouldRepaint(_ReactionPainter old) =>
      old.atlas != atlas || old.cellPx != cellPx;
}
