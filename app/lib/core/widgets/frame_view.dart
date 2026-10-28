import 'dart:async';

import 'package:cached_network_image/cached_network_image.dart';
import 'package:flutter/material.dart';
import 'package:flutter_svga/flutter_svga.dart';
import 'package:lottie/lottie.dart';
import 'package:video_player/video_player.dart';

/// How a cosmetic asset plays. Mirrors `ANIMATION_FORMATS` in `packages/shared`; `none` is a
/// still or self-animating image (PNG, WebP, GIF).
enum MediaFormat {
  none,
  svga,
  lottie,
  mp4;

  /// The server's format, falling back to the URL's extension when it says `none` or is
  /// missing (older payloads), so an SVGA uploaded before formats existed still plays.
  static MediaFormat resolve(String? format, String url) {
    final declared = MediaFormat.values.where((f) => f.name == format);
    if (declared.isNotEmpty && declared.first != MediaFormat.none) {
      return declared.first;
    }
    final path = Uri.tryParse(url)?.path.toLowerCase() ?? url.toLowerCase();
    if (path.endsWith('.svga')) return MediaFormat.svga;
    if (path.endsWith('.json')) return MediaFormat.lottie;
    if (path.endsWith('.mp4')) return MediaFormat.mp4;
    return MediaFormat.none;
  }
}

/// Parsed SVGA movies, shared by every widget showing the same URL. Chat rows, seats and
/// viewer strips repeat the same frames, and decoding is the expensive part, so a movie is
/// decoded once, reference-counted while on screen, and kept in a small LRU once idle.
class SvgaMovieCache {
  SvgaMovieCache._();
  static final instance = SvgaMovieCache._();

  static const _maxIdle = 16;
  final _entries = <String, _MovieEntry>{};
  // Insertion-ordered (a Dart set literal is a LinkedHashSet): first is least recent.
  final _idle = <String>{};

  Future<MovieEntity> retain(String url) {
    final entry = _entries.putIfAbsent(url, () {
      final e = _MovieEntry(SVGAParser.shared.decodeFromURL(url));
      e.future.then(
        (m) {
          // The cache owns disposal; a controller must never free a shared movie.
          m.autorelease = false;
          e.movie = m;
        },
        onError: (_) {
          if (identical(_entries[url], e)) _entries.remove(url);
        },
      );
      return e;
    });
    entry.refs++;
    _idle.remove(url);
    return entry.future;
  }

  void release(String url) {
    final entry = _entries[url];
    if (entry == null) return;
    entry.refs = (entry.refs - 1).clamp(0, 1 << 30);
    if (entry.refs > 0) return;
    _idle.add(url);
    while (_idle.length > _maxIdle) {
      final oldest = _idle.first;
      _idle.remove(oldest);
      _entries.remove(oldest)?.movie?.dispose();
    }
  }
}

class _MovieEntry {
  _MovieEntry(this.future);
  final Future<MovieEntity> future;
  MovieEntity? movie;
  int refs = 0;
}

/// A looping avatar frame (or any looping cosmetic) in any supported format. SVGA below
/// [svgaMinSize] is skipped: it is unreadable that small and costs as much as a large one.
class FrameView extends StatelessWidget {
  const FrameView({
    super.key,
    required this.url,
    this.format,
    required this.size,
    this.svgaMinSize = 32,
  });

  final String url;
  final String? format;
  final double size;
  final double svgaMinSize;

  @override
  Widget build(BuildContext context) {
    final f = MediaFormat.resolve(format, url);
    final Widget child = switch (f) {
      MediaFormat.svga =>
        size < svgaMinSize ? const SizedBox.shrink() : _SvgaLoop(url: url),
      MediaFormat.lottie => Lottie.network(
        url,
        fit: BoxFit.contain,
        errorBuilder: (_, _, _) => const SizedBox.shrink(),
      ),
      // A looping video is not a frame; ignore rather than play one per avatar.
      MediaFormat.mp4 => const SizedBox.shrink(),
      MediaFormat.none => CachedNetworkImage(
        imageUrl: url,
        fit: BoxFit.contain,
        fadeInDuration: Duration.zero,
        errorWidget: (_, _, _) => const SizedBox.shrink(),
      ),
    };
    return IgnorePointer(
      child: SizedBox.square(dimension: size, child: child),
    );
  }
}

class _SvgaLoop extends StatefulWidget {
  const _SvgaLoop({required this.url});
  final String url;

  @override
  State<_SvgaLoop> createState() => _SvgaLoopState();
}

class _SvgaLoopState extends State<_SvgaLoop>
    with SingleTickerProviderStateMixin {
  late final SVGAAnimationController _controller = SVGAAnimationController(
    vsync: this,
  );
  String? _retained;

  @override
  void initState() {
    super.initState();
    _load(widget.url);
  }

  @override
  void didUpdateWidget(covariant _SvgaLoop old) {
    super.didUpdateWidget(old);
    if (old.url != widget.url) _load(widget.url);
  }

  Future<void> _load(String url) async {
    _drop();
    _retained = url;
    try {
      final movie = await SvgaMovieCache.instance.retain(url);
      if (!mounted || _retained != url) return;
      _controller
        ..videoItem = movie
        ..repeat();
    } catch (_) {
      // A broken frame asset just shows no frame.
    }
  }

  void _drop() {
    final url = _retained;
    if (url == null) return;
    _retained = null;
    if (_controller.videoItem != null) {
      _controller
        ..stop()
        ..videoItem = null;
    }
    SvgaMovieCache.instance.release(url);
  }

  @override
  void dispose() {
    _drop();
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) =>
      SVGAImage(_controller, fit: BoxFit.contain);
}

/// Plays a one-shot effect (entrance, big gift) once, then calls [onDone]. Never blocks the
/// queue it belongs to: a failed load, or an effect that runs past [maxDuration], ends it.
class EffectView extends StatefulWidget {
  const EffectView({
    super.key,
    required this.url,
    this.format,
    required this.onDone,
    this.fit = BoxFit.cover,
    this.maxDuration = const Duration(seconds: 8),
  });

  final String url;
  final String? format;
  final VoidCallback onDone;
  final BoxFit fit;
  final Duration maxDuration;

  @override
  State<EffectView> createState() => _EffectViewState();
}

class _EffectViewState extends State<EffectView> with TickerProviderStateMixin {
  SVGAAnimationController? _svga;
  AnimationController? _lottie;
  VideoPlayerController? _video;
  Timer? _guard;
  bool _done = false;
  bool _retainedSvga = false;
  late final MediaFormat _format = MediaFormat.resolve(
    widget.format,
    widget.url,
  );

  @override
  void initState() {
    super.initState();
    _guard = Timer(widget.maxDuration, _finish);
    switch (_format) {
      case MediaFormat.svga:
        _playSvga();
      case MediaFormat.mp4:
        _playVideo();
      case MediaFormat.lottie:
        _lottie = AnimationController(vsync: this);
      case MediaFormat.none:
        // A still image shows for a fixed beat.
        _guard?.cancel();
        _guard = Timer(const Duration(milliseconds: 2600), _finish);
    }
  }

  Future<void> _playSvga() async {
    final c = _svga = SVGAAnimationController(vsync: this);
    try {
      final movie = await SvgaMovieCache.instance.retain(widget.url);
      _retainedSvga = true;
      if (!mounted) return;
      c.videoItem = movie;
      await c.forward(from: 0);
      _finish();
    } catch (_) {
      _finish();
    }
  }

  Future<void> _playVideo() async {
    final v = _video = VideoPlayerController.networkUrl(Uri.parse(widget.url));
    try {
      await v.initialize();
      // Muted: a room's audio belongs to the live session, and the plugin must not take
      // over the audio session LiveKit configured for the microphone.
      await v.setVolume(0);
      if (!mounted) return;
      setState(() {});
      v.addListener(() {
        final value = v.value;
        if (value.hasError ||
            (value.isInitialized &&
                !value.isPlaying &&
                value.position >= value.duration)) {
          _finish();
        }
      });
      await v.play();
    } catch (_) {
      _finish();
    }
  }

  void _finish() {
    if (_done) return;
    _done = true;
    _guard?.cancel();
    if (mounted) widget.onDone();
  }

  @override
  void dispose() {
    _guard?.cancel();
    final svga = _svga;
    if (svga != null) {
      if (svga.videoItem != null) {
        svga
          ..stop()
          ..videoItem = null;
      }
      svga.dispose();
      if (_retainedSvga) SvgaMovieCache.instance.release(widget.url);
    }
    _lottie?.dispose();
    _video?.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final child = switch (_format) {
      MediaFormat.svga => SVGAImage(_svga!, fit: widget.fit),
      MediaFormat.lottie => Lottie.network(
        widget.url,
        controller: _lottie,
        fit: widget.fit,
        onLoaded: (comp) {
          _lottie!
            ..duration = comp.duration
            ..forward(from: 0).whenComplete(_finish);
        },
        errorBuilder: (_, _, _) {
          WidgetsBinding.instance.addPostFrameCallback((_) => _finish());
          return const SizedBox.shrink();
        },
      ),
      MediaFormat.mp4 =>
        _video?.value.isInitialized == true
            ? FittedBox(
                fit: widget.fit,
                child: SizedBox(
                  width: _video!.value.size.width,
                  height: _video!.value.size.height,
                  child: VideoPlayer(_video!),
                ),
              )
            : const SizedBox.shrink(),
      MediaFormat.none => CachedNetworkImage(
        imageUrl: widget.url,
        fit: BoxFit.contain,
        errorWidget: (_, _, _) {
          WidgetsBinding.instance.addPostFrameCallback((_) => _finish());
          return const SizedBox.shrink();
        },
      ),
    };
    return IgnorePointer(child: child);
  }
}
