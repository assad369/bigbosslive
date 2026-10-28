import 'dart:async';
import 'dart:io';

import 'package:cached_network_image/cached_network_image.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:image_picker/image_picker.dart';
import 'package:livekit_client/livekit_client.dart';
import 'package:permission_handler/permission_handler.dart';

import '../../core/providers.dart';
import '../../core/theme/bb_colors.dart';
import '../../core/widgets/widgets.dart';
import 'active_live.dart';

/// Pre-live: camera preview, title, cover, video/party choice. Asks for camera and
/// microphone permission with an explanation first (store review requirement).
///
/// The title starts as the host's display name and the cover as their avatar; both
/// can be changed. Untouched defaults are left to the server, which applies the same
/// rule, so a profile edited elsewhere is never sent stale.
class GoLiveScreen extends ConsumerStatefulWidget {
  const GoLiveScreen({super.key});

  @override
  ConsumerState<GoLiveScreen> createState() => _GoLiveScreenState();
}

class _GoLiveScreenState extends ConsumerState<GoLiveScreen> {
  final _title = TextEditingController();
  LocalVideoTrack? _preview;
  String _type = 'video';
  File? _cover;
  bool _starting = false;
  bool _permissionDenied = false;

  /// Bumped whenever the wanted preview changes, so a camera track that finishes opening
  /// after the user switched to Party (or back) is released instead of leaking.
  int _previewGen = 0;
  AppLifecycleListener? _lifecycle;

  @override
  void initState() {
    super.initState();
    _title.text = _defaultTitle;
    // One session at a time: a minimized viewer room gives up the camera and mic, and a
    // host who is already live is sent back to their room.
    final active = ref.read(activeLiveProvider.notifier);
    final current = active.current;
    if (current != null && current.controller.isHost) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) context.pushReplacement('/live/${current.roomId}');
      });
      return;
    }
    active.close();
    // Back from Settings with access granted: pick up the preview without a restart.
    _lifecycle = AppLifecycleListener(
      onResume: () {
        if (_permissionDenied) unawaited(_initPreview());
      },
    );
    unawaited(_initPreview());
  }

  String get _defaultTitle {
    final name = ref.read(meProvider).brief.displayName.trim();
    return name.length > 60 ? name.substring(0, 60) : name;
  }

  Future<void> _pickCover() async {
    try {
      final x = await ImagePicker().pickImage(
        source: ImageSource.gallery,
        maxWidth: 1080,
        imageQuality: 85,
      );
      if (x != null && mounted) setState(() => _cover = File(x.path));
    } catch (_) {
      if (mounted) showMessage(context, 'Couldn\'t open your photos');
    }
  }

  /// Asks for what this kind of live needs (a Party room is audio only, so no camera) and
  /// opens the camera preview for a video live.
  Future<void> _initPreview() async {
    final gen = ++_previewGen;
    final video = _type == 'video';
    final statuses = await [
      Permission.microphone,
      if (video) Permission.camera,
    ].request();
    if (!mounted || gen != _previewGen) return;
    final denied = statuses.values.any((s) => !s.isGranted);
    setState(() => _permissionDenied = denied);
    if (denied || !video || _preview != null) return;
    try {
      final track = await LocalVideoTrack.createCameraTrack(
        const CameraCaptureOptions(cameraPosition: CameraPosition.front),
      );
      if (!mounted || gen != _previewGen || _preview != null) {
        return unawaited(_release(track));
      }
      setState(() => _preview = track);
    } catch (_) {
      /* preview is best-effort */
    }
  }

  void _setType(String type) {
    if (type == _type) return;
    final preview = _preview;
    setState(() {
      _type = type;
      if (type != 'video') _preview = null;
    });
    // The camera turns off in Party mode rather than staying open behind the gradient.
    if (type != 'video') unawaited(_release(preview));
    unawaited(_initPreview());
  }

  static Future<void> _release(LocalVideoTrack? track) async {
    if (track == null) return;
    try {
      await track.stop();
      await track.dispose();
    } catch (_) {}
  }

  @override
  void dispose() {
    _previewGen++;
    unawaited(_release(_preview));
    _lifecycle?.dispose();
    _title.dispose();
    super.dispose();
  }

  Future<void> _start() async {
    final typed = _title.text.trim();
    // Sending no title lets the server use the display name.
    final title = typed.isEmpty || typed == _defaultTitle ? null : typed;
    setState(() => _starting = true);
    try {
      String? coverUrl;
      if (_cover != null) {
        coverUrl = await ref.read(contentRepo).upload('cover', _cover!);
      }
      final session = await ref
          .read(liveRepo)
          .start(title: title, type: _type, coverUrl: coverUrl);
      final preview = _preview;
      _preview = null;
      _previewGen++;
      await _release(preview);
      if (mounted) {
        context.pushReplacement(
          '/live/${session.detail.room.id}',
          extra: session,
        );
      }
    } catch (e) {
      if (mounted) showError(context, e);
    } finally {
      if (mounted) setState(() => _starting = false);
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    backgroundColor: BBColors.espresso,
    body: Stack(
      fit: StackFit.expand,
      children: [
        if (_preview != null && _type == 'video')
          VideoTrackRenderer(
            _preview!,
            fit: VideoViewFit.cover,
            mirrorMode: VideoViewMirrorMode.mirror,
          )
        else
          const DecoratedBox(
            decoration: BoxDecoration(
              gradient: RadialGradient(
                colors: [BBColors.espressoGlow, BBColors.espresso],
                radius: 1.1,
              ),
            ),
          ),
        const DecoratedBox(
          decoration: BoxDecoration(gradient: BBColors.videoScrim),
        ),
        SafeArea(
          child: Padding(
            padding: const EdgeInsets.all(16),
            child: Column(
              children: [
                Row(
                  children: [
                    IconButton(
                      tooltip: 'Close',
                      onPressed: () => context.pop(),
                      icon: const Icon(
                        Icons.close_rounded,
                        color: BBColors.ivory,
                      ),
                    ),
                    const Spacer(),
                    SegmentedButton<String>(
                      style: SegmentedButton.styleFrom(
                        backgroundColor: BBColors.scrim,
                        foregroundColor: BBColors.ivory,
                        selectedBackgroundColor: BBColors.gold,
                        selectedForegroundColor: BBColors.ink,
                      ),
                      segments: const [
                        ButtonSegment(
                          value: 'video',
                          icon: Icon(Icons.videocam_rounded),
                          label: Text('Video'),
                        ),
                        ButtonSegment(
                          value: 'audio',
                          icon: Icon(Icons.mic_rounded),
                          label: Text('Party'),
                        ),
                      ],
                      selected: {_type},
                      onSelectionChanged: (s) => _setType(s.first),
                    ),
                  ],
                ),
                const SizedBox(height: 16),
                Container(
                  padding: const EdgeInsets.all(12),
                  decoration: BoxDecoration(
                    color: BBColors.scrim,
                    borderRadius: BorderRadius.circular(18),
                  ),
                  child: Row(
                    children: [
                      _CoverTile(
                        file: _cover,
                        avatarUrl: ref.watch(meProvider).brief.avatarUrl,
                        onPick: _pickCover,
                        onReset: () => setState(() => _cover = null),
                      ),
                      const SizedBox(width: 12),
                      Expanded(
                        child: TextField(
                          controller: _title,
                          maxLength: 60,
                          maxLines: 2,
                          style: const TextStyle(
                            color: BBColors.ivory,
                            fontSize: 18,
                            fontWeight: FontWeight.w700,
                          ),
                          decoration: const InputDecoration(
                            filled: false,
                            border: InputBorder.none,
                            enabledBorder: InputBorder.none,
                            focusedBorder: InputBorder.none,
                            hintText: 'What\'s your live about?',
                            hintStyle: TextStyle(color: BBColors.inkSubtle),
                            counterStyle: TextStyle(color: BBColors.inkSubtle),
                          ),
                        ),
                      ),
                    ],
                  ),
                ),
                const Spacer(),
                if (_permissionDenied)
                  Padding(
                    padding: const EdgeInsets.only(bottom: 16),
                    child: Column(
                      children: [
                        Text(
                          _type == 'video'
                              ? 'Camera and microphone access is needed to go live.'
                              : 'Microphone access is needed to open a party room.',
                          textAlign: TextAlign.center,
                          style: const TextStyle(color: BBColors.champagne),
                        ),
                        const TextButton(
                          onPressed: openAppSettings,
                          child: Text('Open settings'),
                        ),
                      ],
                    ),
                  ),
                const Text(
                  'Keep it classy: nudity, violence and hate speech end lives and accounts.',
                  textAlign: TextAlign.center,
                  style: TextStyle(color: BBColors.inkSubtle, fontSize: 12),
                ),
                const SizedBox(height: 12),
                GoldButton(
                  label: _type == 'video' ? 'Go live' : 'Open party room',
                  icon: Icons.bolt_rounded,
                  loading: _starting,
                  onPressed: _permissionDenied ? null : _start,
                ),
              ],
            ),
          ),
        ),
      ],
    ),
  );
}

/// Cover picker. Shows the picked image, else the avatar used by default, else a
/// placeholder. A picked image can be reset back to the default.
class _CoverTile extends StatelessWidget {
  const _CoverTile({
    required this.file,
    required this.avatarUrl,
    required this.onPick,
    required this.onReset,
  });

  final File? file;
  final String? avatarUrl;
  final VoidCallback onPick;
  final VoidCallback onReset;

  @override
  Widget build(BuildContext context) {
    const placeholder = Icon(
      Icons.add_photo_alternate_outlined,
      color: BBColors.champagne,
    );
    final image = file != null
        ? Image.file(file!, fit: BoxFit.cover)
        : avatarUrl != null
        ? CachedNetworkImage(
            imageUrl: avatarUrl!,
            fit: BoxFit.cover,
            errorWidget: (_, _, _) => placeholder,
          )
        : placeholder;
    return Semantics(
      button: true,
      label: 'Change cover',
      child: GestureDetector(
        onTap: onPick,
        child: SizedBox(
          width: 72,
          height: 96,
          child: Stack(
            fit: StackFit.expand,
            children: [
              ClipRRect(
                borderRadius: BorderRadius.circular(12),
                child: ColoredBox(color: BBColors.champagneVeil, child: image),
              ),
              if (file != null || avatarUrl != null)
                Positioned(
                  right: 4,
                  bottom: 4,
                  child: _TileBadge(
                    icon: file != null
                        ? Icons.close_rounded
                        : Icons.edit_rounded,
                    onTap: file != null ? onReset : onPick,
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }
}

class _TileBadge extends StatelessWidget {
  const _TileBadge({required this.icon, required this.onTap});
  final IconData icon;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) => GestureDetector(
    onTap: onTap,
    child: Container(
      padding: const EdgeInsets.all(4),
      decoration: const BoxDecoration(
        color: BBColors.scrim,
        shape: BoxShape.circle,
      ),
      child: Icon(icon, size: 14, color: BBColors.ivory),
    ),
  );
}
