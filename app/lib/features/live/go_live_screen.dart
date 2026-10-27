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
    unawaited(_initPreview());
  }

  String get _defaultTitle {
    final name = ref.read(meProvider).brief.displayName.trim();
    return name.length > 60 ? name.substring(0, 60) : name;
  }

  Future<void> _pickCover() async {
    final x = await ImagePicker().pickImage(
      source: ImageSource.gallery,
      maxWidth: 1080,
      imageQuality: 85,
    );
    if (x != null && mounted) setState(() => _cover = File(x.path));
  }

  Future<void> _initPreview() async {
    final statuses = await [Permission.camera, Permission.microphone].request();
    if (statuses.values.any((s) => !s.isGranted)) {
      if (mounted) setState(() => _permissionDenied = true);
      return;
    }
    if (_type != 'video') return;
    try {
      final track = await LocalVideoTrack.createCameraTrack(
        const CameraCaptureOptions(cameraPosition: CameraPosition.front),
      );
      if (!mounted) return unawaited(track.stop());
      setState(() => _preview = track);
    } catch (_) {
      /* preview is best-effort */
    }
  }

  @override
  void dispose() {
    unawaited(_preview?.stop());
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
      await _preview?.stop();
      _preview = null;
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
                colors: [Color(0xFF4A3722), BBColors.espresso],
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
                      onSelectionChanged: (s) {
                        setState(() => _type = s.first);
                        if (_type == 'video' && _preview == null) {
                          unawaited(_initPreview());
                        }
                      },
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
                  const Padding(
                    padding: EdgeInsets.only(bottom: 16),
                    child: Column(
                      children: [
                        Text(
                          'Camera and microphone access is needed to go live.',
                          textAlign: TextAlign.center,
                          style: TextStyle(color: BBColors.champagne),
                        ),
                        TextButton(
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
                child: ColoredBox(color: const Color(0x33F3E5C3), child: image),
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
