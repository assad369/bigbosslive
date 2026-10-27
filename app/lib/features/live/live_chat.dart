import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:go_router/go_router.dart';
import 'package:just_audio/just_audio.dart';
import 'package:record/record.dart';

import '../../core/theme/bb_colors.dart';
import '../../core/widgets/widgets.dart';
import '../../models/models.dart';
import '../profile/profile_screens.dart';
import 'live_room_controller.dart';
import 'live_stage.dart';

/// Plays one voice message at a time. It leaves the audio session to LiveKit, which already
/// owns it for the room's audio.
class _VoicePlayback extends ChangeNotifier {
  final _player = AudioPlayer(
    handleInterruptions: false,
    handleAudioSessionActivation: false,
  );
  StreamSubscription<PlayerState>? _sub;
  String? playingId;

  _VoicePlayback() {
    _sub = _player.playerStateStream.listen((s) {
      if (s.processingState == ProcessingState.completed) {
        playingId = null;
        notifyListeners();
      }
    });
  }

  Future<void> toggle(ChatLine line) async {
    if (playingId == line.id) {
      playingId = null;
      notifyListeners();
      await _player.stop();
      return;
    }
    playingId = line.id;
    notifyListeners();
    try {
      await _player.setUrl(line.voiceUrl!);
      unawaited(_player.play());
    } catch (_) {
      playingId = null;
      notifyListeners();
    }
  }

  @override
  void dispose() {
    unawaited(_sub?.cancel());
    unawaited(_player.dispose());
    super.dispose();
  }
}

/// The in-room message list: newest at the bottom, fading out at the top. Tapping a name
/// opens the person; long-pressing a message offers reply, copy, report and delete.
class LiveChatList extends StatefulWidget {
  const LiveChatList({
    super.key,
    required this.c,
    required this.onTapUser,
    required this.onReply,
  });
  final LiveRoomController c;
  final void Function(UserBrief user) onTapUser;
  final void Function(ChatLine line) onReply;

  @override
  State<LiveChatList> createState() => _LiveChatListState();
}

class _LiveChatListState extends State<LiveChatList> {
  final _voice = _VoicePlayback();

  @override
  void dispose() {
    _voice.dispose();
    super.dispose();
  }

  Future<void> _menu(ChatLine line) async {
    final c = widget.c;
    final mine = line.user?.id == c.myUid;
    final action = await showModalBottomSheet<String>(
      context: context,
      builder: (ctx) => SafeArea(
        child: Wrap(
          children: [
            ListTile(
              leading: const Icon(Icons.reply_rounded),
              title: const Text('Reply'),
              onTap: () => ctx.pop('reply'),
            ),
            if (line.kind == ChatKind.chat)
              ListTile(
                leading: const Icon(Icons.copy_rounded),
                title: const Text('Copy'),
                onTap: () => ctx.pop('copy'),
              ),
            if (!mine) ...[
              ListTile(
                leading: const Icon(Icons.flag_outlined),
                title: const Text('Report message'),
                onTap: () => ctx.pop('report'),
              ),
              ListTile(
                leading: const Icon(Icons.person_off_outlined),
                title: const Text('Report user'),
                onTap: () => ctx.pop('report_user'),
              ),
            ],
            if (mine || c.isModerator)
              ListTile(
                leading: const Icon(
                  Icons.delete_outline,
                  color: BBColors.danger,
                ),
                title: const Text(
                  'Delete for everyone',
                  style: TextStyle(color: BBColors.danger),
                ),
                onTap: () => ctx.pop('delete'),
              ),
          ],
        ),
      ),
    );
    if (!mounted || action == null) return;
    switch (action) {
      case 'reply':
        widget.onReply(line);
      case 'copy':
        await Clipboard.setData(ClipboardData(text: line.text));
        if (mounted) showMessage(context, 'Copied');
      case 'report':
        await ReportSheet.show(
          context,
          targetType: 'message',
          targetId: line.id,
        );
      case 'report_user':
        await ReportSheet.show(
          context,
          targetType: 'user',
          targetId: line.user!.id,
        );
      case 'delete':
        try {
          await c.deleteMessage(line.id);
        } catch (e) {
          if (mounted) showError(context, e);
        }
    }
  }

  @override
  Widget build(BuildContext context) {
    final lines = widget.c.chat;
    final height = (MediaQuery.sizeOf(context).height * 0.3).clamp(
      160.0,
      240.0,
    );
    return SizedBox(
      height: height,
      child: ShaderMask(
        shaderCallback: (r) => const LinearGradient(
          begin: Alignment.topCenter,
          end: Alignment.bottomCenter,
          colors: [Colors.transparent, Colors.black],
          stops: [0, 0.16],
        ).createShader(r),
        blendMode: BlendMode.dstIn,
        child: ListenableBuilder(
          listenable: _voice,
          builder: (context, _) => ListView.builder(
            reverse: true,
            padding: const EdgeInsets.fromLTRB(10, 0, 70, 4),
            itemCount: lines.length,
            itemBuilder: (_, i) {
              final line = lines[lines.length - 1 - i];
              return ChatBubble(
                key: ValueKey(line.id),
                line: line,
                playing: _voice.playingId == line.id,
                onTapUser: widget.onTapUser,
                onLongPress: line.isMessage ? () => _menu(line) : null,
                onPlay: () => _voice.toggle(line),
              );
            },
          ),
        ),
      ),
    );
  }
}

class ChatBubble extends StatelessWidget {
  const ChatBubble({
    super.key,
    required this.line,
    required this.onTapUser,
    this.onLongPress,
    this.onPlay,
    this.playing = false,
  });
  final ChatLine line;
  final void Function(UserBrief user) onTapUser;
  final VoidCallback? onLongPress;
  final VoidCallback? onPlay;
  final bool playing;

  @override
  Widget build(BuildContext context) {
    final user = line.user;
    if (line.kind == ChatKind.system) {
      return Align(
        alignment: Alignment.centerLeft,
        child: Container(
          margin: const EdgeInsets.only(bottom: 4),
          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
          decoration: BoxDecoration(
            color: BBColors.goldTint,
            borderRadius: BorderRadius.circular(14),
          ),
          child: Text(
            line.text,
            style: const TextStyle(color: BBColors.goldLight, fontSize: 12),
          ),
        ),
      );
    }
    final name = GestureDetector(
      onTap: user == null ? null : () => onTapUser(user),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (user != null) ...[
            LevelBadge(user.level, dense: true),
            const SizedBox(width: 3),
          ],
          if (line.role == RoomRole.host || line.role == RoomRole.admin) ...[
            RoleBadge(line.role, dense: true),
            const SizedBox(width: 3),
          ],
          Flexible(
            child: Text(
              user?.displayName ?? '',
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(
                color: BBColors.goldLight,
                fontWeight: FontWeight.w700,
                fontSize: 12,
              ),
            ),
          ),
        ],
      ),
    );
    final Widget content = switch (line.kind) {
      ChatKind.voice => _VoiceChip(
        seconds: line.voiceSec,
        playing: playing,
        onTap: onPlay,
      ),
      ChatKind.join => const Text(
        'joined the live',
        style: TextStyle(color: BBColors.champagne, fontSize: 12),
      ),
      ChatKind.gift => Text(
        '🎁 ${line.text}',
        style: const TextStyle(
          color: BBColors.goldLight,
          fontSize: 13,
          fontWeight: FontWeight.w600,
        ),
      ),
      _ => Text(
        line.text,
        maxLines: 4,
        overflow: TextOverflow.ellipsis,
        style: const TextStyle(color: BBColors.ivory, fontSize: 13),
      ),
    };
    return Padding(
      padding: const EdgeInsets.only(bottom: 4),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          GestureDetector(
            onTap: user == null ? null : () => onTapUser(user),
            child: BBAvatar(
              url: user?.avatarUrl,
              name: user?.displayName ?? '',
              size: 26,
              vip: (user?.vipTier ?? 0) > 0,
            ),
          ),
          const SizedBox(width: 6),
          Flexible(
            child: GestureDetector(
              onLongPress: onLongPress,
              child: Container(
                padding: const EdgeInsets.fromLTRB(9, 5, 9, 6),
                decoration: BoxDecoration(
                  color: BBColors.scrim,
                  borderRadius: BorderRadius.circular(14),
                ),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    name,
                    if (line.replyTo != null)
                      Container(
                        margin: const EdgeInsets.only(top: 3),
                        padding: const EdgeInsets.only(left: 6),
                        decoration: const BoxDecoration(
                          border: Border(
                            left: BorderSide(
                              color: BBColors.goldLight,
                              width: 2,
                            ),
                          ),
                        ),
                        child: Text(
                          '${line.replyTo!.displayName}: ${line.replyTo!.text}',
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: const TextStyle(
                            color: BBColors.inkSubtle,
                            fontSize: 11,
                          ),
                        ),
                      ),
                    const SizedBox(height: 2),
                    content,
                  ],
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _VoiceChip extends StatelessWidget {
  const _VoiceChip({
    required this.seconds,
    required this.playing,
    required this.onTap,
  });
  final int seconds;
  final bool playing;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) => InkWell(
    onTap: onTap,
    child: Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Icon(
          playing ? Icons.stop_circle_rounded : Icons.play_circle_fill_rounded,
          color: BBColors.goldLight,
          size: 22,
        ),
        const SizedBox(width: 4),
        // Width grows with length, like a waveform placeholder.
        Container(
          width: 30 + seconds.clamp(1, 60) * 1.6,
          height: 3,
          decoration: BoxDecoration(
            color: playing ? BBColors.goldLight : BBColors.champagne,
            borderRadius: BorderRadius.circular(2),
          ),
        ),
        const SizedBox(width: 6),
        Text(
          '$seconds″',
          style: const TextStyle(color: BBColors.ivory, fontSize: 12),
        ),
      ],
    ),
  );
}

/// Expanded message input: reply preview, text field and send. Viewers can hold the mic
/// to record a voice message (up to a minute) when the field is empty.
class ChatComposer extends StatefulWidget {
  const ChatComposer({
    super.key,
    required this.c,
    required this.replyTo,
    required this.onClearReply,
    required this.onClose,
  });
  final LiveRoomController c;
  final ChatLine? replyTo;
  final VoidCallback onClearReply;
  final VoidCallback onClose;

  @override
  State<ChatComposer> createState() => _ChatComposerState();
}

class _ChatComposerState extends State<ChatComposer> {
  static const _maxVoiceSec = 60;
  final _field = TextEditingController();
  final _focus = FocusNode();
  final _recorder = AudioRecorder();
  bool _sending = false;
  bool _recording = false;
  bool _cancelVoice = false;
  DateTime? _recordStart;
  Timer? _recordTick;

  @override
  void initState() {
    super.initState();
    _field.addListener(() => setState(() {}));
    _focus.requestFocus();
  }

  @override
  void dispose() {
    _recordTick?.cancel();
    unawaited(_recorder.dispose());
    _field.dispose();
    _focus.dispose();
    super.dispose();
  }

  /// Hosts and guests are already talking live; voice notes are for the audience.
  bool get _canRecord => !widget.c.isHost && !widget.c.onSeat;

  Future<void> _send() async {
    final text = _field.text.trim();
    if (text.isEmpty || _sending) return;
    setState(() => _sending = true);
    try {
      await widget.c.sendChat(text, replyToId: widget.replyTo?.id);
      _field.clear();
      widget.onClearReply();
    } catch (e) {
      // The text stays in the field so nothing is lost.
      if (mounted) showError(context, e);
    } finally {
      if (mounted) setState(() => _sending = false);
    }
  }

  Future<void> _startRecording() async {
    if (_recording || _sending) return;
    if (!await _recorder.hasPermission()) {
      if (mounted) showMessage(context, 'Allow microphone access to record');
      return;
    }
    final path =
        '${Directory.systemTemp.path}/voice_${DateTime.now().millisecondsSinceEpoch}.m4a';
    await _recorder.start(
      const RecordConfig(
        encoder: AudioEncoder.aacLc,
        bitRate: 64000,
        sampleRate: 44100,
        numChannels: 1,
      ),
      path: path,
    );
    unawaited(HapticFeedback.mediumImpact());
    setState(() {
      _recording = true;
      _cancelVoice = false;
      _recordStart = DateTime.now();
    });
    _recordTick = Timer.periodic(const Duration(milliseconds: 250), (_) {
      if (_elapsed >= _maxVoiceSec) {
        unawaited(_stopRecording());
      } else {
        setState(() {});
      }
    });
  }

  int get _elapsed => _recordStart == null
      ? 0
      : DateTime.now().difference(_recordStart!).inSeconds;

  Future<void> _stopRecording() async {
    if (!_recording) return;
    _recordTick?.cancel();
    final seconds = _elapsed.clamp(0, _maxVoiceSec);
    final path = await _recorder.stop();
    setState(() => _recording = false);
    if (path == null) return;
    final file = File(path);
    if (_cancelVoice || seconds < 1) {
      if (seconds < 1 && !_cancelVoice && mounted) {
        showMessage(context, 'Hold to record a voice message');
      }
      await file.delete().catchError((Object _) => file);
      return;
    }
    setState(() => _sending = true);
    try {
      await widget.c.sendVoice(file, seconds, replyToId: widget.replyTo?.id);
      widget.onClearReply();
    } catch (e) {
      if (mounted) showError(context, e);
    } finally {
      await file.delete().catchError((Object _) => file);
      if (mounted) setState(() => _sending = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final reply = widget.replyTo;
    final empty = _field.text.trim().isEmpty;
    return Container(
      color: BBColors.espresso,
      padding: const EdgeInsets.fromLTRB(6, 6, 6, 6),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (reply != null)
            Padding(
              padding: const EdgeInsets.fromLTRB(8, 0, 0, 4),
              child: Row(
                children: [
                  const Icon(
                    Icons.reply_rounded,
                    size: 16,
                    color: BBColors.goldLight,
                  ),
                  const SizedBox(width: 6),
                  Expanded(
                    child: Text(
                      'Replying to ${reply.user?.displayName ?? ''}: '
                      '${reply.kind == ChatKind.voice ? '🎤 Voice message' : reply.text}',
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(
                        color: BBColors.champagne,
                        fontSize: 12,
                      ),
                    ),
                  ),
                  IconButton(
                    visualDensity: VisualDensity.compact,
                    onPressed: widget.onClearReply,
                    icon: const Icon(
                      Icons.close,
                      size: 16,
                      color: BBColors.champagne,
                    ),
                  ),
                ],
              ),
            ),
          Row(
            children: [
              IconButton(
                onPressed: widget.onClose,
                icon: const Icon(
                  Icons.keyboard_arrow_down_rounded,
                  color: BBColors.ivory,
                ),
              ),
              Expanded(
                child: _recording
                    ? Container(
                        height: 40,
                        alignment: Alignment.center,
                        decoration: BoxDecoration(
                          color: _cancelVoice
                              ? BBColors.danger
                              : BBColors.scrim,
                          borderRadius: BorderRadius.circular(20),
                        ),
                        child: Text(
                          _cancelVoice
                              ? 'Release to cancel'
                              : '● ${_elapsed}s  ·  slide up to cancel',
                          style: const TextStyle(color: BBColors.ivory),
                        ),
                      )
                    : TextField(
                        controller: _field,
                        focusNode: _focus,
                        maxLength: 300,
                        minLines: 1,
                        maxLines: 4,
                        style: const TextStyle(color: BBColors.ivory),
                        cursorColor: BBColors.goldLight,
                        textInputAction: TextInputAction.send,
                        decoration: InputDecoration(
                          filled: true,
                          fillColor: BBColors.scrim,
                          counterText: '',
                          hintText: 'Say something…',
                          hintStyle: const TextStyle(color: BBColors.inkSubtle),
                          isDense: true,
                          contentPadding: const EdgeInsets.symmetric(
                            horizontal: 14,
                            vertical: 10,
                          ),
                          border: OutlineInputBorder(
                            borderRadius: BorderRadius.circular(20),
                            borderSide: BorderSide.none,
                          ),
                        ),
                        onSubmitted: (_) => _send(),
                      ),
              ),
              const SizedBox(width: 6),
              if (empty && _canRecord)
                GestureDetector(
                  onLongPressStart: (_) => _startRecording(),
                  onLongPressMoveUpdate: (d) {
                    final cancel = d.offsetFromOrigin.dy < -60;
                    if (cancel != _cancelVoice) {
                      setState(() => _cancelVoice = cancel);
                    }
                  },
                  onLongPressEnd: (_) => _stopRecording(),
                  onTap: () =>
                      showMessage(context, 'Hold to record a voice message'),
                  child: _RoundIcon(
                    icon: _recording ? Icons.mic : Icons.mic_none_rounded,
                    active: _recording,
                  ),
                )
              else
                GestureDetector(
                  onTap: _sending ? null : _send,
                  child: _RoundIcon(
                    icon: Icons.send_rounded,
                    active: !empty,
                    busy: _sending,
                  ),
                ),
            ],
          ),
        ],
      ),
    );
  }
}

class _RoundIcon extends StatelessWidget {
  const _RoundIcon({
    required this.icon,
    this.active = false,
    this.busy = false,
  });
  final IconData icon;
  final bool active;
  final bool busy;
  @override
  Widget build(BuildContext context) => Container(
    width: 40,
    height: 40,
    decoration: BoxDecoration(
      shape: BoxShape.circle,
      gradient: active ? BBColors.goldGradient : null,
      color: active ? null : BBColors.scrim,
    ),
    child: busy
        ? const Padding(
            padding: EdgeInsets.all(11),
            child: CircularProgressIndicator(
              strokeWidth: 2,
              color: BBColors.ink,
            ),
          )
        : Icon(icon, color: active ? BBColors.ink : BBColors.ivory, size: 20),
  );
}
