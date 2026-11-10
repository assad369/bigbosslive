import 'dart:async';

import 'package:cached_network_image/cached_network_image.dart';
import 'package:flutter/material.dart';
import 'package:flutter_cache_manager/flutter_cache_manager.dart';
import 'package:flutter_svga/flutter_svga.dart';
import 'package:video_player/video_player.dart';

import '../../models/models.dart';
import '../theme/bb_colors.dart';
import 'frame_view.dart';

/// Badge MP4s: many small, long-lived files. Kept apart from gift and image caches so gift
/// traffic never evicts a badge someone wears.
class TierBadgeVideoCache {
  TierBadgeVideoCache._();
  static final instance = CacheManager(
    Config(
      'tierBadgeVideo',
      stalePeriod: const Duration(days: 30),
      maxNrOfCacheObjects: 60,
    ),
  );
}

/// How many badge videos may decode at once. Phones expose few hardware decoders and a live
/// room already holds some for its video tracks, so the cap drops while in a room. A badge
/// refused a lease shows its SVGA or image instead and upgrades when one frees.
class VideoBadgeBudget extends ChangeNotifier {
  VideoBadgeBudget._();
  static final instance = VideoBadgeBudget._();

  static const _outside = 6;
  static const _inRoom = 3;

  int _active = 0;
  bool _inLiveRoom = false;

  int get active => _active;
  int get maxConcurrent => _inLiveRoom ? _inRoom : _outside;

  /// Set by the live room while it is connected.
  set inLiveRoom(bool v) {
    if (_inLiveRoom == v) return;
    _inLiveRoom = v;
    notifyListeners();
  }

  /// Elastic: may be refused. Pair a `true` with [release].
  bool tryAcquire() {
    if (_active >= maxConcurrent) return false;
    _active++;
    return true;
  }

  void release() {
    if (_active == 0) return;
    _active--;
    notifyListeners();
  }

  @visibleForTesting
  void reset() {
    _active = 0;
    _inLiveRoom = false;
  }
}

enum _Stage { mp4, svga, image, none }

/// A tier package badge in any of its renditions. Precedence: MP4 > SVGA > image, and every
/// failure falls to the next one down, with the static image as the floor. MP4s are muted,
/// looping, mixed with other audio, and played from a downloaded file. With [animate] off
/// only the image is drawn (an SVGA-only badge still plays: it has nothing else).
class TierBadgeView extends StatefulWidget {
  const TierBadgeView({
    super.key,
    required this.badge,
    required this.size,
    this.animate = true,
  });

  final TierBadge badge;
  final double size;
  final bool animate;

  @override
  State<TierBadgeView> createState() => _TierBadgeViewState();
}

class _TierBadgeViewState extends State<TierBadgeView>
    with SingleTickerProviderStateMixin {
  static const _initTimeout = Duration(seconds: 12);

  _Stage _stage = _Stage.none;
  bool _mp4Failed = false;
  bool _svgaFailed = false;

  VideoPlayerController? _video;
  bool _leased = false;
  bool _waitingForLease = false;

  SVGAAnimationController? _svga;
  String? _svgaUrl;

  @override
  void initState() {
    super.initState();
    _pick();
  }

  @override
  void didUpdateWidget(covariant TierBadgeView old) {
    super.didUpdateWidget(old);
    if (old.badge != widget.badge || old.animate != widget.animate) {
      _teardown();
      _mp4Failed = false;
      _svgaFailed = false;
      _pick();
    }
  }

  @override
  void dispose() {
    _teardown();
    _svga?.dispose();
    super.dispose();
  }

  /// The best rendition still worth trying.
  _Stage get _best {
    final b = widget.badge;
    if (widget.animate && b.mp4Url != null && !_mp4Failed) return _Stage.mp4;
    final svgaOnly = b.imageUrl == null;
    if ((widget.animate || svgaOnly) && b.svgaUrl != null && !_svgaFailed) {
      return _Stage.svga;
    }
    if (b.imageUrl != null) return _Stage.image;
    return _Stage.none;
  }

  void _pick() {
    final next = _best;
    if (next == _Stage.mp4) {
      if (VideoBadgeBudget.instance.tryAcquire()) {
        _leased = true;
        _stage = _Stage.mp4;
        unawaited(_startVideo(widget.badge.mp4Url!));
        return;
      }
      // Refused: show what is cheaper now, upgrade when a lease frees.
      _waitForLease();
      _stage = _belowMp4;
    } else {
      _stage = next;
    }
    if (_stage == _Stage.svga) unawaited(_startSvga(widget.badge.svgaUrl!));
  }

  _Stage get _belowMp4 {
    final b = widget.badge;
    if (b.svgaUrl != null && !_svgaFailed) return _Stage.svga;
    if (b.imageUrl != null) return _Stage.image;
    return _Stage.none;
  }

  void _waitForLease() {
    if (_waitingForLease) return;
    _waitingForLease = true;
    VideoBadgeBudget.instance.addListener(_onBudget);
  }

  void _onBudget() {
    if (!mounted || _stage == _Stage.mp4 || _mp4Failed) return;
    if (!VideoBadgeBudget.instance.tryAcquire()) return;
    _stopWaiting();
    _leased = true;
    _dropSvga();
    setState(() => _stage = _Stage.mp4);
    unawaited(_startVideo(widget.badge.mp4Url!));
  }

  void _stopWaiting() {
    if (!_waitingForLease) return;
    _waitingForLease = false;
    VideoBadgeBudget.instance.removeListener(_onBudget);
  }

  Future<void> _startVideo(String url) async {
    final badge = widget.badge;
    try {
      final file = await TierBadgeVideoCache.instance
          .getSingleFile(url)
          .timeout(const Duration(seconds: 15));
      if (!mounted || widget.badge != badge) return;
      final v = VideoPlayerController.file(
        file,
        videoPlayerOptions: VideoPlayerOptions(mixWithOthers: true),
      );
      _video = v;
      await v.initialize().timeout(_initTimeout);
      if (!mounted || _video != v) {
        await v.dispose();
        return;
      }
      await v.setVolume(0);
      await v.setLooping(true);
      await v.play();
      if (mounted) setState(() {});
    } catch (_) {
      if (!mounted || widget.badge != badge) return;
      _giveUpVideo();
    }
  }

  /// MP4 failed on this device: fall to SVGA (needs no hardware decoder), then the image.
  void _giveUpVideo() {
    // Latch before tearing down: releasing the lease notifies listeners synchronously.
    _mp4Failed = true;
    _disposeVideo();
    setState(() => _stage = _best);
    if (_stage == _Stage.svga) unawaited(_startSvga(widget.badge.svgaUrl!));
  }

  Future<void> _startSvga(String url) async {
    _dropSvga();
    _svgaUrl = url;
    try {
      final movie = await SvgaMovieCache.instance.retain(url);
      if (!mounted || _svgaUrl != url) return;
      final c = _svga ??= SVGAAnimationController(vsync: this);
      c
        ..videoItem = movie
        ..repeat();
      setState(() {});
    } catch (_) {
      if (!mounted || _svgaUrl != url) return;
      _svgaUrl = null;
      _svgaFailed = true;
      setState(() => _stage = _best == _Stage.svga ? _Stage.image : _best);
    }
  }

  void _dropSvga() {
    final url = _svgaUrl;
    if (url == null) return;
    _svgaUrl = null;
    final c = _svga;
    if (c != null && c.videoItem != null) {
      c
        ..stop()
        ..videoItem = null;
    }
    SvgaMovieCache.instance.release(url);
  }

  void _disposeVideo() {
    final v = _video;
    _video = null;
    if (v != null) unawaited(v.dispose());
    if (_leased) {
      _leased = false;
      VideoBadgeBudget.instance.release();
    }
  }

  void _teardown() {
    _stopWaiting();
    _disposeVideo();
    _dropSvga();
  }

  Widget _image() {
    final url = widget.badge.imageUrl;
    if (url == null) return const SizedBox.shrink();
    final px = (widget.size * MediaQuery.devicePixelRatioOf(context)).round();
    return CachedNetworkImage(
      imageUrl: url,
      fit: BoxFit.contain,
      memCacheWidth: px,
      fadeInDuration: Duration.zero,
      placeholder: (_, _) => const SizedBox.shrink(),
      errorWidget: (_, _, _) => const SizedBox.shrink(),
    );
  }

  @override
  Widget build(BuildContext context) {
    final Widget child;
    switch (_stage) {
      case _Stage.mp4:
        final v = _video;
        if (v == null || !v.value.isInitialized) {
          // Downloading or starting: the static image holds the slot.
          child = _image();
        } else {
          final video = FittedBox(
            fit: BoxFit.contain,
            child: SizedBox(
              width: v.value.size.width,
              height: v.value.size.height,
              child: VideoPlayer(v),
            ),
          );
          child = widget.badge.additive
              ? ColorFiltered(colorFilter: _lumaKey, child: video)
              : video;
        }
      case _Stage.svga:
        final c = _svga;
        child = c == null || c.videoItem == null
            ? _image()
            : SVGAImage(c, fit: BoxFit.contain);
      case _Stage.image:
        child = _image();
      case _Stage.none:
        child = const SizedBox.shrink();
    }
    return IgnorePointer(
      child: SizedBox.square(dimension: widget.size, child: child),
    );
  }

  /// Additive clips are exported on black: alpha follows luminance, so black is clear and
  /// the avatar underneath keeps its colours.
  static const _lumaKey = ColorFilter.matrix(<double>[
    1, 0, 0, 0, 0, //
    0, 1, 0, 0, 0, //
    0, 0, 1, 0, 0, //
    0.2126, 0.7152, 0.0722, 0, 0, //
  ]);
}

/// Where a badge sits: the bottom-right of the avatar's photo circle, a little over a third
/// of its size, with a thin ring that separates it from the photo.
class AvatarBadgeSlot {
  AvatarBadgeSlot._();

  /// Smaller avatars draw no badge: it would be a speck.
  static const minAvatarSize = 28.0;

  static double sizeFor(double avatar) => (avatar * 0.36).clamp(12.0, 44.0);

  /// The badge circle for an avatar of [avatarSize].
  static Widget badge(TierBadge badge, double avatarSize, {double? size}) {
    final s = size ?? sizeFor(avatarSize);
    return Container(
      width: s,
      height: s,
      decoration: BoxDecoration(
        shape: BoxShape.circle,
        border: Border.all(color: BBColors.surface, width: 1.5),
      ),
      child: ClipOval(
        child: TierBadgeView(badge: badge, size: s),
      ),
    );
  }
}

/// A tier badge on its own, beside text rather than on an avatar: chat rows (where the
/// avatar leaves it off) and live cards.
class InlineTierBadge extends StatelessWidget {
  const InlineTierBadge({super.key, required this.badge, this.size = 22});
  final TierBadge badge;
  final double size;

  @override
  Widget build(BuildContext context) => Container(
    width: size,
    height: size,
    decoration: BoxDecoration(
      shape: BoxShape.circle,
      border: Border.all(color: BBColors.surface, width: 1.5),
    ),
    child: ClipOval(
      child: TierBadgeView(badge: badge, size: size),
    ),
  );
}
