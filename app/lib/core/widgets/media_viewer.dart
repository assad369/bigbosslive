import 'dart:async';

import 'package:cached_network_image/cached_network_image.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:video_player/video_player.dart';

import '../media/gallery_saver.dart';
import '../theme/bb_colors.dart';
import 'widgets.dart';

/// Whether [url] looks like a video file (by its extension).
bool looksLikeVideo(String url) {
  final path = Uri.tryParse(url)?.path.toLowerCase() ?? '';
  return path.endsWith('.mp4') ||
      path.endsWith('.mov') ||
      path.endsWith('.m4v');
}

/// A photo or video shown full screen: pinch or double-tap to zoom, swipe down to close,
/// and a Save button that puts it in the device gallery.
class MediaViewerScreen extends StatefulWidget {
  const MediaViewerScreen({
    super.key,
    required this.url,
    this.heroTag,
    this.isVideo = false,
  });
  final String url;

  /// Shared with the thumbnail the viewer opens from, for the zoom-in transition.
  final Object? heroTag;
  final bool isVideo;

  /// Opens the viewer over everything, on the root navigator.
  static Future<void> open(
    BuildContext context, {
    required String url,
    Object? heroTag,
    bool? isVideo,
  }) => Navigator.of(context, rootNavigator: true).push(
    PageRouteBuilder<void>(
      opaque: false,
      transitionDuration: const Duration(milliseconds: 220),
      reverseTransitionDuration: const Duration(milliseconds: 200),
      pageBuilder: (_, _, _) => MediaViewerScreen(
        url: url,
        heroTag: heroTag,
        isVideo: isVideo ?? looksLikeVideo(url),
      ),
      transitionsBuilder: (_, animation, _, child) =>
          FadeTransition(opacity: animation, child: child),
    ),
  );

  @override
  State<MediaViewerScreen> createState() => _MediaViewerScreenState();
}

class _MediaViewerScreenState extends State<MediaViewerScreen>
    with SingleTickerProviderStateMixin {
  /// A swipe this far (or a fling) closes the viewer.
  static const _dismissDistance = 120.0;
  static const _dismissVelocity = 800.0;
  static const _zoomed = 2.5;

  final _transform = TransformationController();
  late final AnimationController _zoom = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 220),
  )..addListener(() => _transform.value = _zoomTween!.evaluate(_zoom));
  Matrix4Tween? _zoomTween;
  Offset _doubleTapAt = Offset.zero;

  /// Vertical offset of a swipe-to-close in progress.
  double _drag = 0;
  bool _saving = false;

  bool get _isZoomed => _transform.value.getMaxScaleOnAxis() > 1.01;

  @override
  void dispose() {
    _zoom.dispose();
    _transform.dispose();
    super.dispose();
  }

  void _toggleZoom() {
    final Matrix4 end;
    if (_isZoomed) {
      end = Matrix4.identity();
    } else {
      // Zoom in around the double-tapped point.
      final p = _doubleTapAt;
      end = Matrix4.identity()
        ..translateByDouble(-p.dx * (_zoomed - 1), -p.dy * (_zoomed - 1), 0, 1)
        ..scaleByDouble(_zoomed, _zoomed, 1, 1);
    }
    _zoomTween = Matrix4Tween(begin: _transform.value, end: end);
    unawaited(_zoom.forward(from: 0).then((_) => setState(() {})));
  }

  void _dragBy(double dy) => setState(() => _drag += dy);

  void _dragEnd(double velocity) {
    if (_drag.abs() > _dismissDistance || velocity.abs() > _dismissVelocity) {
      Navigator.of(context).pop();
    } else {
      setState(() => _drag = 0);
    }
  }

  Future<void> _save() async {
    if (_saving) return;
    setState(() => _saving = true);
    try {
      await GallerySaver.save(widget.url, isVideo: widget.isVideo);
      if (mounted) showMessage(context, 'Saved to gallery');
    } catch (e) {
      if (mounted) showError(context, e);
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  Widget _image() => GestureDetector(
    onDoubleTapDown: (d) => _doubleTapAt = d.localPosition,
    onDoubleTap: _toggleZoom,
    child: InteractiveViewer(
      transformationController: _transform,
      maxScale: 5,
      // Unzoomed, a one-finger drag is a swipe to close, not a pan.
      panEnabled: _isZoomed,
      onInteractionUpdate: (d) {
        if (!_isZoomed && d.pointerCount == 1) _dragBy(d.focalPointDelta.dy);
      },
      onInteractionEnd: (d) {
        if (_drag != 0) {
          _dragEnd(d.velocity.pixelsPerSecond.dy);
        } else {
          setState(() {}); // panEnabled follows the new zoom.
        }
      },
      child: SizedBox.expand(
        child: _hero(
          CachedNetworkImage(
            imageUrl: widget.url,
            fit: BoxFit.contain,
            placeholder: (_, _) => const Center(
              child: CircularProgressIndicator(color: BBColors.goldLight),
            ),
            errorWidget: (_, _, _) => const Center(
              child: Icon(
                Icons.broken_image_outlined,
                color: BBColors.champagne,
                size: 48,
              ),
            ),
          ),
        ),
      ),
    ),
  );

  Widget _hero(Widget child) =>
      widget.heroTag == null ? child : Hero(tag: widget.heroTag!, child: child);

  @override
  Widget build(BuildContext context) {
    final fade = (1 - _drag.abs() / 400).clamp(0.3, 1.0);
    return AnnotatedRegion<SystemUiOverlayStyle>(
      value: SystemUiOverlayStyle.light,
      child: Scaffold(
        backgroundColor: BBColors.espresso.withValues(alpha: fade),
        body: Stack(
          children: [
            Positioned.fill(
              child: Transform.translate(
                offset: Offset(0, _drag),
                child: widget.isVideo
                    ? GestureDetector(
                        onVerticalDragUpdate: (d) => _dragBy(d.delta.dy),
                        onVerticalDragEnd: (d) =>
                            _dragEnd(d.velocity.pixelsPerSecond.dy),
                        child: _VideoView(url: widget.url),
                      )
                    : _image(),
              ),
            ),
            SafeArea(
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: 4),
                child: Row(
                  children: [
                    _RoundAction(
                      icon: Icons.close_rounded,
                      tooltip: 'Close',
                      onTap: () => Navigator.of(context).pop(),
                    ),
                    const Spacer(),
                    _RoundAction(
                      icon: Icons.download_rounded,
                      tooltip: widget.isVideo ? 'Save video' : 'Save photo',
                      busy: _saving,
                      onTap: _save,
                    ),
                  ],
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _RoundAction extends StatelessWidget {
  const _RoundAction({
    required this.icon,
    required this.tooltip,
    required this.onTap,
    this.busy = false,
  });
  final IconData icon;
  final String tooltip;
  final VoidCallback onTap;
  final bool busy;

  @override
  Widget build(BuildContext context) => IconButton(
    tooltip: tooltip,
    onPressed: busy ? null : onTap,
    style: IconButton.styleFrom(
      backgroundColor: BBColors.scrim,
      disabledBackgroundColor: BBColors.scrim,
    ),
    icon: busy
        ? const SizedBox.square(
            dimension: 22,
            child: CircularProgressIndicator(
              strokeWidth: 2,
              color: BBColors.goldLight,
            ),
          )
        : Icon(icon, color: BBColors.ivory),
  );
}

/// A network video: tap to play or pause, with a scrubbable progress bar.
class _VideoView extends StatefulWidget {
  const _VideoView({required this.url});
  final String url;

  @override
  State<_VideoView> createState() => _VideoViewState();
}

class _VideoViewState extends State<_VideoView> {
  late final VideoPlayerController _video = VideoPlayerController.networkUrl(
    Uri.parse(widget.url),
  );
  bool _failed = false;

  @override
  void initState() {
    super.initState();
    unawaited(
      _video
          .initialize()
          .then((_) async {
            if (!mounted) return;
            setState(() {});
            await _video.play();
          })
          .catchError((Object _) {
            if (mounted) setState(() => _failed = true);
          }),
    );
  }

  @override
  void dispose() {
    unawaited(_video.dispose());
    super.dispose();
  }

  void _toggle() {
    final v = _video.value;
    unawaited(v.isPlaying ? _video.pause() : _video.play());
  }

  @override
  Widget build(BuildContext context) {
    if (_failed) {
      return const Center(
        child: Text(
          'Couldn’t play this video',
          style: TextStyle(color: BBColors.champagne),
        ),
      );
    }
    if (!_video.value.isInitialized) {
      return const Center(
        child: CircularProgressIndicator(color: BBColors.goldLight),
      );
    }
    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      onTap: _toggle,
      child: Stack(
        alignment: Alignment.center,
        children: [
          AspectRatio(
            aspectRatio: _video.value.aspectRatio,
            child: VideoPlayer(_video),
          ),
          ValueListenableBuilder(
            valueListenable: _video,
            builder: (_, v, _) => v.isPlaying
                ? const SizedBox.shrink()
                : const DecoratedBox(
                    decoration: BoxDecoration(
                      color: BBColors.scrim,
                      shape: BoxShape.circle,
                    ),
                    child: Padding(
                      padding: EdgeInsets.all(12),
                      child: Icon(
                        Icons.play_arrow_rounded,
                        size: 48,
                        color: BBColors.ivory,
                      ),
                    ),
                  ),
          ),
          Positioned(
            left: 16,
            right: 16,
            bottom: 24 + MediaQuery.paddingOf(context).bottom,
            child: VideoProgressIndicator(
              _video,
              allowScrubbing: true,
              colors: const VideoProgressColors(
                playedColor: BBColors.goldLight,
                bufferedColor: BBColors.champagneVeil,
                backgroundColor: BBColors.champagneTint,
              ),
            ),
          ),
        ],
      ),
    );
  }
}
