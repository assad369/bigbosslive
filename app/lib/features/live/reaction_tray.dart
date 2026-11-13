import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../core/theme/bb_colors.dart';
import '../../models/models.dart';
import 'live_controls.dart';

/// The bottom bar's heart: a tap reveals the reaction tray with every [LiveReaction]
/// (Like, Love, Haha, Wow, Fire…), and a second tap closes it.
///
/// The tray floats to the left of the button in the app overlay, so nothing under it moves.
/// It scrolls sideways when the reactions don't fit, starting with the classic ones next to
/// the button. It stays open while the viewer keeps tapping (each tap is one reaction) and
/// closes on a tap outside, on the button again, or [_idleClose] after the last tap.
class ReactionTrayButton extends StatefulWidget {
  const ReactionTrayButton({
    super.key,
    required this.onReact,
    this.size = LiveRoundButton.disc,
  });
  final ValueChanged<LiveReaction> onReact;

  /// The button's disc.
  final double size;

  @override
  State<ReactionTrayButton> createState() => _ReactionTrayButtonState();
}

class _ReactionTrayButtonState extends State<ReactionTrayButton>
    with SingleTickerProviderStateMixin {
  static const _idleClose = Duration(seconds: 4);

  final _portal = OverlayPortalController();
  final _link = LayerLink();
  late final AnimationController _anim = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 260),
  );
  Timer? _idle;

  /// Width the tray may take: from the screen's left edge (inside the safe area) to just
  /// left of the button. Measured on open.
  double _room = double.infinity;

  @override
  void dispose() {
    _idle?.cancel();
    _anim.dispose();
    super.dispose();
  }

  void _toggle() => _portal.isShowing && _anim.status != AnimationStatus.reverse
      ? _close()
      : _open();

  void _open() {
    final box = context.findRenderObject() as RenderBox?;
    if (box != null && box.hasSize) {
      _room =
          box.localToGlobal(Offset.zero).dx -
          _Tray.gap -
          MediaQuery.paddingOf(context).left -
          _Tray.margin;
    }
    unawaited(HapticFeedback.selectionClick());
    _portal.show();
    unawaited(_anim.forward());
    _armIdle();
  }

  void _close() {
    _idle?.cancel();
    // Reopening mid-reverse cancels it; only hide once fully closed.
    _anim.reverse().whenCompleteOrCancel(() {
      if (mounted && _anim.isDismissed) _portal.hide();
    });
  }

  void _armIdle() {
    _idle?.cancel();
    _idle = Timer(_idleClose, () {
      if (mounted) _close();
    });
  }

  void _react(LiveReaction r) {
    unawaited(HapticFeedback.selectionClick());
    widget.onReact(r);
    _armIdle();
  }

  @override
  Widget build(BuildContext context) => CompositedTransformTarget(
    link: _link,
    child: OverlayPortal(
      controller: _portal,
      overlayChildBuilder: (context) => Stack(
        children: [
          // A tap outside (the button included) closes the tray without reaching what is below.
          Positioned.fill(
            child: GestureDetector(
              behavior: HitTestBehavior.opaque,
              onTap: _close,
            ),
          ),
          CompositedTransformFollower(
            link: _link,
            targetAnchor: Alignment.centerLeft,
            followerAnchor: Alignment.centerRight,
            offset: const Offset(-_Tray.gap, 0),
            child: Align(
              alignment: Alignment.centerRight,
              widthFactor: 1,
              heightFactor: 1,
              child: _Tray(anim: _anim, onReact: _react, maxWidth: _room),
            ),
          ),
        ],
      ),
      child: LiveRoundButton(
        icon: Icons.favorite_rounded,
        tooltip: 'Reactions',
        size: widget.size,
        onTap: _toggle,
      ),
    ),
  );
}

class _Tray extends StatelessWidget {
  const _Tray({
    required this.anim,
    required this.onReact,
    required this.maxWidth,
  });
  final AnimationController anim;
  final ValueChanged<LiveReaction> onReact;

  /// Room left of the button (see [_ReactionTrayButtonState._room]).
  final double maxWidth;

  /// Space between the tray and the button, and between the tray and the screen edge.
  static const gap = 8.0;
  static const margin = 8.0;
  static const _padding = 6.0;
  static const _cell = 40.0;

  /// The scrolling edge fades in over this distance.
  static const _fade = 18.0;

  @override
  Widget build(BuildContext context) {
    const reactions = LiveReaction.values;
    // Fit the room left of the button (and, before it's measured, the screen less a disc).
    final room = maxWidth.isFinite
        ? maxWidth
        : MediaQuery.sizeOf(context).width - 76 - margin;
    final full = reactions.length * _cell;
    final width = math.max(_cell * 3, math.min(full, room - _padding * 2));
    final scrolls = full > width;
    final tray = CurvedAnimation(
      parent: anim,
      curve: Curves.easeOutBack,
      reverseCurve: Curves.easeIn,
    );
    Widget row = SingleChildScrollView(
      scrollDirection: Axis.horizontal,
      // Starts at the end next to the button, where the classic reactions are.
      reverse: true,
      physics: const BouncingScrollPhysics(),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          // Last first, so the tray reads outward from the button: Like, Love… nearest.
          for (final r in reactions.reversed)
            ScaleTransition(
              // Pop in one after another, outward from the button.
              scale: CurvedAnimation(
                parent: anim,
                curve: Interval(
                  math.min(0.4, r.index * 0.03),
                  math.min(0.4, r.index * 0.03) + 0.6,
                  curve: Curves.easeOutBack,
                ),
              ),
              child: _EmojiCell(
                reaction: r,
                size: _cell,
                onTap: () => onReact(r),
              ),
            ),
        ],
      ),
    );
    if (scrolls) {
      // Fade the far edge so it reads as "more this way".
      row = ShaderMask(
        blendMode: BlendMode.dstIn,
        shaderCallback: (rect) => LinearGradient(
          colors: const [Colors.transparent, BBColors.surface],
          stops: [0, _fade / rect.width],
        ).createShader(rect),
        child: row,
      );
    }
    return FadeTransition(
      opacity: CurvedAnimation(parent: anim, curve: const Interval(0, 0.6)),
      child: ScaleTransition(
        scale: tray,
        alignment: Alignment.centerRight,
        child: Material(
          color: BBColors.espresso.withValues(alpha: 0.94),
          elevation: 8,
          shadowColor: BBColors.espressoShade,
          shape: const StadiumBorder(
            side: BorderSide(color: BBColors.goldOutline),
          ),
          clipBehavior: Clip.antiAlias,
          child: Padding(
            padding: const EdgeInsets.symmetric(
              horizontal: _padding,
              vertical: 4,
            ),
            child: SizedBox(width: width, height: _cell, child: row),
          ),
        ),
      ),
    );
  }
}

/// One reaction in the tray: grows while pressed.
class _EmojiCell extends StatefulWidget {
  const _EmojiCell({
    required this.reaction,
    required this.size,
    required this.onTap,
  });
  final LiveReaction reaction;
  final double size;
  final VoidCallback onTap;

  @override
  State<_EmojiCell> createState() => _EmojiCellState();
}

class _EmojiCellState extends State<_EmojiCell> {
  bool _pressed = false;

  void _press(bool v) {
    if (_pressed != v) setState(() => _pressed = v);
  }

  @override
  Widget build(BuildContext context) => Semantics(
    button: true,
    label: widget.reaction.label,
    excludeSemantics: true,
    child: Tooltip(
      message: widget.reaction.label,
      preferBelow: false,
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTapDown: (_) => _press(true),
        onTapUp: (_) => _press(false),
        onTapCancel: () => _press(false),
        onTap: widget.onTap,
        child: SizedBox.square(
          dimension: widget.size,
          child: Center(
            child: AnimatedScale(
              scale: _pressed ? 1.35 : 1,
              duration: const Duration(milliseconds: 120),
              curve: Curves.easeOut,
              child: Text(
                widget.reaction.emoji,
                style: TextStyle(fontSize: widget.size * 0.66, height: 1),
              ),
            ),
          ),
        ),
      ),
    ),
  );
}
