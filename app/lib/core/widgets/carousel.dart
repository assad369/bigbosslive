import 'dart:async';

import 'package:flutter/material.dart';

import '../theme/bb_colors.dart';

/// Auto-advancing horizontal carousel with page dots. Loops, pauses while touched, and
/// stops ticking when off screen (the timer only advances a visible, attached controller).
class BBCarousel extends StatefulWidget {
  const BBCarousel({
    super.key,
    required this.itemCount,
    required this.itemBuilder,
    required this.height,
    this.viewportFraction = 0.92,
    this.interval = const Duration(seconds: 5),
    this.padding = const EdgeInsets.fromLTRB(4, 12, 4, 0),
    this.showDots = true,
  });

  final int itemCount;
  final IndexedWidgetBuilder itemBuilder;
  final double height;
  final double viewportFraction;
  final Duration interval;
  final EdgeInsets padding;
  final bool showDots;

  @override
  State<BBCarousel> createState() => _BBCarouselState();
}

class _BBCarouselState extends State<BBCarousel> {
  // Start far from 0 so the carousel can loop backwards as well as forwards.
  static const _loopBase = 10000;
  late final PageController _controller = PageController(
    viewportFraction: widget.viewportFraction,
    initialPage: widget.itemCount > 1 ? _loopBase * widget.itemCount : 0,
  );
  Timer? _timer;
  int _index = 0;
  bool _touching = false;

  bool get _loops => widget.itemCount > 1;

  @override
  void initState() {
    super.initState();
    _restart();
  }

  @override
  void didUpdateWidget(covariant BBCarousel old) {
    super.didUpdateWidget(old);
    if (old.itemCount != widget.itemCount || old.interval != widget.interval) {
      if (_index >= widget.itemCount) _index = 0;
      _restart();
    }
  }

  void _restart() {
    _timer?.cancel();
    if (!_loops) return;
    _timer = Timer.periodic(widget.interval, (_) {
      if (_touching || !_controller.hasClients) return;
      // Skip ticks while the route is covered or the app is in the background.
      if (!(TickerMode.valuesOf(context).enabled)) return;
      final page = _controller.page?.round() ?? 0;
      unawaited(
        _controller.animateToPage(
          page + 1,
          duration: const Duration(milliseconds: 600),
          curve: Curves.easeOutCubic,
        ),
      );
    });
  }

  @override
  void dispose() {
    _timer?.cancel();
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    if (widget.itemCount == 0) return const SizedBox.shrink();
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        SizedBox(
          height: widget.height,
          child: Listener(
            onPointerDown: (_) => _touching = true,
            onPointerUp: (_) => _touching = false,
            onPointerCancel: (_) => _touching = false,
            child: PageView.builder(
              controller: _controller,
              itemCount: _loops ? null : widget.itemCount,
              onPageChanged: (p) =>
                  setState(() => _index = p % widget.itemCount),
              itemBuilder: (context, p) => Padding(
                padding: widget.padding,
                child: widget.itemBuilder(context, p % widget.itemCount),
              ),
            ),
          ),
        ),
        if (widget.showDots && _loops)
          Padding(
            padding: const EdgeInsets.only(top: 6),
            child: Row(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                for (var i = 0; i < widget.itemCount; i++)
                  AnimatedContainer(
                    duration: const Duration(milliseconds: 250),
                    margin: const EdgeInsets.symmetric(horizontal: 2),
                    width: i == _index ? 14 : 5,
                    height: 5,
                    decoration: BoxDecoration(
                      color: i == _index ? BBColors.gold : BBColors.border,
                      borderRadius: BorderRadius.circular(3),
                    ),
                  ),
              ],
            ),
          ),
      ],
    );
  }
}
