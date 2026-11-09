import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:url_launcher/url_launcher.dart';
import 'package:webview_flutter/webview_flutter.dart';
import 'package:webview_flutter_android/webview_flutter_android.dart';
import 'package:webview_flutter_wkwebview/webview_flutter_wkwebview.dart';

import '../../core/config/env.dart';
import '../../core/theme/bb_colors.dart';
import '../../core/widgets/widgets.dart';
import '../../models/models.dart';
import 'live_room_controller.dart';
import 'youtube_sheet.dart';

/// Re-seek when the player drifts this far from the room's position.
const _maxDriftMs = 2000;

/// How often the player's position is compared with the room's.
const _driftCheck = Duration(seconds: 5);

/// YouTube's minimum player viewport is 200×200 (API terms).
const ytPlayerSize = 200.0;
const _barHeight = 40.0;

/// YouTube's player states (`YT.PlayerState`).
abstract final class YtPlayerState {
  static const ended = 0;
  static const playing = 1;
}

/// Error codes the player reports when a video can't play here.
const _unplayableErrors = {2, 5, 100, 101, 150, 153};

/// The floating card that plays the live's YouTube song: YouTube's official player, at
/// least 200×200, which the viewer can drag to either side or hide. Everyone's player
/// follows the server state, so the room hears one song in sync without anyone mixing
/// audio into a microphone.
///
/// Lives on the room screen only: when the live is minimized the card is unmounted and the
/// song stops for this viewer, since YouTube may not play hidden or in the background.
class LiveYouTubeCard extends StatefulWidget {
  const LiveYouTubeCard({super.key, required this.c});
  final LiveRoomController c;

  @override
  State<LiveYouTubeCard> createState() => _LiveYouTubeCardState();
}

class _LiveYouTubeCardState extends State<LiveYouTubeCard> {
  /// Top-left of the card, in the Stack's coordinates; null until dragged.
  Offset? _pos;

  /// Per-viewer "hide the player". A hidden player is unmounted, so it stops.
  bool _hidden = false;

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: widget.c,
    builder: (context, _) {
      final current = widget.c.youtube?.current;
      if (current == null) return const SizedBox.shrink();
      final pad = MediaQuery.paddingOf(context);
      if (_hidden) {
        return Stack(
          children: [
            Positioned(
              left: 8,
              top: pad.top + 96,
              child: _HiddenPill(
                title: current.title,
                onShow: () => setState(() => _hidden = false),
              ),
            ),
          ],
        );
      }
      return LayoutBuilder(
        builder: (context, box) {
          const w = ytPlayerSize;
          const h = ytPlayerSize + _barHeight;
          const minX = 8.0;
          final maxX = (box.maxWidth - w - 8).clamp(minX, double.infinity);
          final minY = pad.top + 96;
          final maxY = (box.maxHeight - h - pad.bottom - 220).clamp(
            minY,
            double.infinity,
          );
          final pos = _pos ?? Offset(minX, minY);
          final clamped = Offset(
            pos.dx.clamp(minX, maxX),
            pos.dy.clamp(minY, maxY),
          );
          return Stack(
            children: [
              AnimatedPositioned(
                duration: _pos == null
                    ? Duration.zero
                    : const Duration(milliseconds: 180),
                curve: Curves.easeOut,
                left: clamped.dx,
                top: clamped.dy,
                width: w,
                height: h,
                child: GestureDetector(
                  onPanUpdate: (d) => setState(() => _pos = clamped + d.delta),
                  // Snap to the nearer side, so the card never sits mid-stage.
                  onPanEnd: (_) => setState(() {
                    final mid = (box.maxWidth - w) / 2;
                    _pos = Offset(clamped.dx < mid ? minX : maxX, clamped.dy);
                  }),
                  child: _Card(
                    c: widget.c,
                    current: current,
                    onHide: () => setState(() => _hidden = true),
                  ),
                ),
              ),
            ],
          );
        },
      );
    },
  );
}

class _Card extends StatelessWidget {
  const _Card({required this.c, required this.current, required this.onHide});
  final LiveRoomController c;
  final YtNowPlaying current;
  final VoidCallback onHide;

  @override
  Widget build(BuildContext context) {
    Future<void> cmd(Map<String, Object?> command) async {
      final error = await c.youtubeCommand(command);
      if (error != null && context.mounted) showMessage(context, error);
    }

    return DecoratedBox(
      decoration: const BoxDecoration(
        color: BBColors.espresso,
        borderRadius: BorderRadius.all(Radius.circular(14)),
        boxShadow: [BoxShadow(color: BBColors.espressoShade, blurRadius: 12)],
      ),
      child: ClipRRect(
        borderRadius: const BorderRadius.all(Radius.circular(14)),
        child: Column(
          children: [
            SizedBox.square(
              dimension: ytPlayerSize,
              child: YouTubeRoomPlayer(c: c),
            ),
            SizedBox(
              height: _barHeight,
              child: Row(
                children: [
                  const SizedBox(width: 8),
                  const Icon(
                    Icons.smart_display_rounded,
                    size: 16,
                    color: BBColors.pkRed,
                  ),
                  const SizedBox(width: 6),
                  Expanded(
                    child: Text(
                      current.title,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(
                        fontSize: 11,
                        fontWeight: FontWeight.w600,
                        color: BBColors.ivory,
                      ),
                    ),
                  ),
                  if (c.canControlYouTube) ...[
                    _BarButton(
                      icon: current.playing
                          ? Icons.pause_rounded
                          : Icons.play_arrow_rounded,
                      tooltip: current.playing ? 'Pause' : 'Play',
                      onTap: () =>
                          cmd({'action': current.playing ? 'pause' : 'resume'}),
                    ),
                    _BarButton(
                      icon: Icons.skip_next_rounded,
                      tooltip: 'Next',
                      onTap: () =>
                          cmd({'action': 'next', 'fromQid': current.qid}),
                    ),
                    _BarButton(
                      icon: Icons.queue_music_rounded,
                      tooltip: 'Up next',
                      onTap: () => YouTubeSheet.show(context, c, upNext: true),
                    ),
                  ],
                  _BarButton(
                    icon: Icons.close_rounded,
                    tooltip: 'Hide player',
                    onTap: onHide,
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _BarButton extends StatelessWidget {
  const _BarButton({
    required this.icon,
    required this.tooltip,
    required this.onTap,
  });
  final IconData icon;
  final String tooltip;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) => Tooltip(
    message: tooltip,
    child: InkResponse(
      onTap: onTap,
      radius: 18,
      child: Padding(
        padding: const EdgeInsets.all(5),
        child: Icon(icon, size: 18, color: BBColors.goldLight),
      ),
    ),
  );
}

/// What a viewer who hid the player sees: the song, and a way back.
class _HiddenPill extends StatelessWidget {
  const _HiddenPill({required this.title, required this.onShow});
  final String title;
  final VoidCallback onShow;

  @override
  Widget build(BuildContext context) => Semantics(
    button: true,
    label: 'Show YouTube player, $title',
    child: GestureDetector(
      onTap: onShow,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
        decoration: const BoxDecoration(
          color: BBColors.scrim,
          borderRadius: BorderRadius.all(Radius.circular(999)),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(
              Icons.smart_display_rounded,
              size: 14,
              color: BBColors.pkRed,
            ),
            const SizedBox(width: 4),
            ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 140),
              child: Text(
                title,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(fontSize: 11, color: BBColors.ivory),
              ),
            ),
            const SizedBox(width: 6),
            const Text(
              'Show',
              style: TextStyle(
                fontSize: 11,
                color: BBColors.goldLight,
                fontWeight: FontWeight.w700,
              ),
            ),
          ],
        ),
      ),
    ),
  );
}

/// YouTube's IFrame player in a web view, following the room's state: loads when the song
/// changes, re-seeks when it drifts, and tells the server when the song ends (the server
/// checks that against its clock). Touches never reach the player, so a viewer can't pause
/// their copy out of sync.
class YouTubeRoomPlayer extends StatefulWidget {
  const YouTubeRoomPlayer({super.key, required this.c});
  final LiveRoomController c;

  @override
  State<YouTubeRoomPlayer> createState() => _YouTubeRoomPlayerState();
}

class _YouTubeRoomPlayerState extends State<YouTubeRoomPlayer> {
  static Future<String>? _html;

  WebViewController? _web;
  bool _ready = false;
  String? _loadedQid;
  String? _endedQid;
  int? _error;
  int _state = -1;

  /// The app is in the background: YouTube may not play there.
  bool _away = false;
  Timer? _drift;
  AppLifecycleListener? _life;

  /// What the last sync saw, so unrelated controller changes (chat, gifts) do nothing.
  YtNowPlaying? _seen;
  int _seenOffset = 0;
  bool _seenAudio = true;

  LiveRoomController get _c => widget.c;

  @override
  void initState() {
    super.initState();
    _html ??= rootBundle
        .loadString('assets/youtube/player.html')
        .then((s) => s.replaceAll('__ORIGIN_HOST__', Env.linkHost));
    _seen = _c.youtube?.current;
    _seenOffset = _c.serverOffsetMs;
    _seenAudio = _c.roomAudioOn;
    _c.addListener(_onRoom);
    _life = AppLifecycleListener(
      onHide: () {
        _away = true;
        unawaited(_run('bb.pause()'));
      },
      onShow: () {
        _away = false;
        unawaited(_sync());
      },
    );
    _drift = Timer.periodic(_driftCheck, (_) => unawaited(_checkDrift()));
    unawaited(_create());
  }

  @override
  void dispose() {
    _c.removeListener(_onRoom);
    _drift?.cancel();
    _life?.dispose();
    super.dispose();
  }

  Future<void> _create() async {
    final html = await _html!;
    if (!mounted) return;
    var params = const PlatformWebViewControllerCreationParams();
    if (WebViewPlatform.instance is WebKitWebViewPlatform) {
      params = WebKitWebViewControllerCreationParams(
        allowsInlineMediaPlayback: true,
        mediaTypesRequiringUserAction: const <PlaybackMediaTypes>{},
      );
    }
    final web = WebViewController.fromPlatformCreationParams(params);
    await web.setJavaScriptMode(JavaScriptMode.unrestricted);
    await web.setBackgroundColor(BBColors.espresso);
    final platform = web.platform;
    if (platform is AndroidWebViewController) {
      await platform.setMediaPlaybackRequiresUserGesture(false);
    }
    await web.addJavaScriptChannel(
      'YtBridge',
      onMessageReceived: (m) => _onEvent(m.message),
    );
    await web.setNavigationDelegate(
      NavigationDelegate(onNavigationRequest: _guard),
    );
    await web.loadHtmlString(html, baseUrl: 'https://${Env.linkHost}/');
    if (mounted) setState(() => _web = web);
  }

  void _onRoom() {
    final cur = _c.youtube?.current;
    if (cur != _seen || _c.serverOffsetMs != _seenOffset) {
      _seen = cur;
      _seenOffset = _c.serverOffsetMs;
      unawaited(_sync());
    }
    if (_c.roomAudioOn != _seenAudio) {
      _seenAudio = _c.roomAudioOn;
      unawaited(_run('bb.mute(${!_seenAudio})'));
    }
    // Room roles may change who sees Skip.
    if (_error != null && mounted) setState(() {});
  }

  Future<void> _run(String source) async {
    final web = _web;
    if (web == null || !_ready) return;
    try {
      await web.runJavaScript(source);
    } catch (e) {
      debugPrint('YouTube player call failed: $e');
    }
  }

  Future<num?> _time() async {
    final web = _web;
    if (web == null || !_ready) return null;
    try {
      final t = await web.runJavaScriptReturningResult('bb.time()');
      return t is num ? t : num.tryParse('$t');
    } catch (_) {
      return null;
    }
  }

  Future<void> _sync() async {
    if (!_ready || !mounted) return;
    final cur = _c.youtube?.current;
    if (cur == null) {
      _loadedQid = null;
      await _run('bb.stop()');
      return;
    }
    final expected = ytPositionMs(cur, _c.serverNowMs);
    final play = cur.playing && !_away;
    if (cur.qid != _loadedQid) {
      _loadedQid = cur.qid;
      _endedQid = null;
      if (_error != null) setState(() => _error = null);
      await _run(
        'bb.load(${_jsString(cur.videoId)}, ${expected / 1000}, $play)',
      );
    } else {
      await _checkDrift();
      await _run(play ? 'bb.play()' : 'bb.pause()');
    }
    await _run('bb.mute(${!_c.roomAudioOn})');
  }

  Future<void> _checkDrift() async {
    final cur = _c.youtube?.current;
    if (cur == null || cur.qid != _loadedQid || _away) return;
    if (_state != YtPlayerState.playing && cur.playing) return;
    final t = await _time();
    if (t == null || t < 0) return;
    final expected = ytPositionMs(cur, _c.serverNowMs);
    if ((t * 1000 - expected).abs() > _maxDriftMs) {
      await _run('bb.seek(${expected / 1000})');
    }
  }

  void _onEvent(String message) {
    if (!mounted) return;
    final Map<String, dynamic> e;
    try {
      final decoded = jsonDecode(message);
      if (decoded is! Map) return;
      e = Map<String, dynamic>.from(decoded);
    } catch (_) {
      return;
    }
    switch (e['event']) {
      case 'ready':
        _ready = true;
        unawaited(_sync());
      case 'state':
        _state = (e['state'] as num?)?.toInt() ?? -1;
        if (_state == YtPlayerState.ended) unawaited(_reportEnded());
        if (_state == YtPlayerState.playing && _error != null) {
          setState(() => _error = null);
        }
      case 'error':
        final code = (e['code'] as num?)?.toInt() ?? -1;
        debugPrint('YouTube player error $code');
        if (_unplayableErrors.contains(code) || code == -1) {
          setState(() => _error = code);
        }
    }
  }

  Future<void> _reportEnded() async {
    final qid = _loadedQid;
    if (qid == null || qid == _endedQid) return;
    _endedQid = qid;
    await _c.youtubeEnded(qid);
  }

  /// Taps on YouTube links (the logo, the title) open YouTube itself.
  NavigationDecision _guard(NavigationRequest r) {
    if (!r.isMainFrame) return NavigationDecision.navigate;
    final url = Uri.tryParse(r.url);
    if (url == null) return NavigationDecision.prevent;
    if (url.scheme == 'about' ||
        url.scheme == 'data' ||
        (url.scheme == 'https' && url.host == Env.linkHost)) {
      return NavigationDecision.navigate;
    }
    final host = url.host.toLowerCase();
    if (host == 'youtube.com' ||
        host.endsWith('.youtube.com') ||
        host == 'youtu.be') {
      unawaited(launchUrl(url, mode: LaunchMode.externalApplication));
    }
    return NavigationDecision.prevent;
  }

  @override
  Widget build(BuildContext context) {
    final web = _web;
    return Stack(
      fit: StackFit.expand,
      children: [
        if (web == null)
          const ColoredBox(color: BBColors.espresso)
        else
          IgnorePointer(child: WebViewWidget(controller: web)),
        if (_error != null)
          ColoredBox(
            color: BBColors.espresso,
            child: Padding(
              padding: const EdgeInsets.all(16),
              child: Column(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  const Icon(
                    Icons.error_outline_rounded,
                    color: BBColors.champagne,
                  ),
                  const SizedBox(height: 6),
                  Text(
                    _error == -1
                        ? "YouTube didn't load"
                        : "This video can't play here",
                    textAlign: TextAlign.center,
                    style: const TextStyle(
                      fontSize: 12,
                      color: BBColors.champagne,
                    ),
                  ),
                  if (_c.canControlYouTube && _error != -1) ...[
                    const SizedBox(height: 8),
                    TextButton(
                      onPressed: () {
                        final qid = _loadedQid;
                        if (qid == null) return;
                        unawaited(
                          _c.youtubeCommand({'action': 'next', 'fromQid': qid}),
                        );
                      },
                      child: const Text(
                        'Skip',
                        style: TextStyle(color: BBColors.goldLight),
                      ),
                    ),
                  ],
                ],
              ),
            ),
          ),
      ],
    );
  }
}

/// [s] as a JavaScript string literal. Video ids are validated by the server, but nothing
/// reaches the web view unquoted.
String _jsString(String s) =>
    "'${s.replaceAll(r'\', r'\\').replaceAll("'", r"\'").replaceAll('\n', '')}'";
