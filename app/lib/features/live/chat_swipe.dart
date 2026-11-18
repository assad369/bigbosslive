import 'package:flutter/material.dart';

/// Swipe the live room sideways to hide the chat (to the right) or bring it back (to the
/// left).
///
/// It sits around the whole room, so it still catches the swipe while the chat is hidden.
/// Horizontal scrollers inside (top viewers, the PK guest strip) and the draggable YouTube
/// card are deeper in the hit test and keep their own drags. A swipe that starts in the
/// system's edge gesture zone is left to it: that's back on iOS and on Android's gesture
/// navigation.
class ChatSwipeDetector extends StatefulWidget {
  const ChatSwipeDetector({
    super.key,
    required this.onChatVisible,
    required this.child,
    this.enabled = true,
  });

  /// Called with false for a swipe to the right, true for one to the left.
  final ValueChanged<bool> onChatVisible;
  final Widget child;

  /// Off while typing: the composer owns the screen then.
  final bool enabled;

  /// A flick this fast (logical px/s) counts whatever its length.
  static const flingVelocity = 300.0;

  /// A slow drag counts once it has travelled this far.
  static const minDistance = 72.0;

  /// The edge zone left to the system when it reports none.
  static const edgeGuard = 24.0;

  @override
  State<ChatSwipeDetector> createState() => _ChatSwipeDetectorState();
}

class _ChatSwipeDetectorState extends State<ChatSwipeDetector> {
  /// Null while no swipe is being tracked (none started, or it began at an edge).
  double? _dx;

  void _start(DragStartDetails d) {
    final width = MediaQuery.sizeOf(context).width;
    final insets = MediaQuery.systemGestureInsetsOf(context);
    final left = insets.left > ChatSwipeDetector.edgeGuard
        ? insets.left
        : ChatSwipeDetector.edgeGuard;
    final right = insets.right > ChatSwipeDetector.edgeGuard
        ? insets.right
        : ChatSwipeDetector.edgeGuard;
    final x = d.globalPosition.dx;
    _dx = x < left || x > width - right ? null : 0;
  }

  void _update(DragUpdateDetails d) {
    if (_dx != null) _dx = _dx! + d.delta.dx;
  }

  void _end(DragEndDetails d) {
    final dx = _dx;
    _dx = null;
    if (dx == null || !widget.enabled) return;
    final v = d.primaryVelocity ?? 0;
    final double direction;
    if (v.abs() >= ChatSwipeDetector.flingVelocity) {
      direction = v;
    } else if (dx.abs() >= ChatSwipeDetector.minDistance) {
      direction = dx;
    } else {
      return;
    }
    widget.onChatVisible(direction < 0);
  }

  @override
  Widget build(BuildContext context) => GestureDetector(
    behavior: HitTestBehavior.translucent,
    onHorizontalDragStart: widget.enabled ? _start : null,
    onHorizontalDragUpdate: widget.enabled ? _update : null,
    onHorizontalDragEnd: widget.enabled ? _end : null,
    onHorizontalDragCancel: () => _dx = null,
    child: widget.child,
  );
}
