import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/providers.dart';
import '../../core/theme/bb_colors.dart';
import '../../core/widgets/widgets.dart';
import '../../models/models.dart';
import 'active_live.dart';
import 'gift_panel.dart';
import 'live_chat.dart';
import 'live_controls.dart';
import 'live_dialogs.dart';
import 'live_effects.dart';
import 'live_room_controller.dart';
import 'live_sheets.dart';
import 'live_stage.dart';
import 'pk_widgets.dart';

/// Router `extra` carrying a locked room's password from the home screen.
class RoomPassword {
  const RoomPassword(this.value);
  final String value;
}

class LiveRoomScreen extends ConsumerStatefulWidget {
  const LiveRoomScreen({
    super.key,
    required this.roomId,
    this.hostSession,
    this.password,
  });
  final String roomId;
  final LiveSession? hostSession;

  /// For a locked room, entered on the home screen before opening it.
  final String? password;

  @override
  ConsumerState<LiveRoomScreen> createState() => _LiveRoomScreenState();
}

class _LiveRoomScreenState extends ConsumerState<LiveRoomScreen> {
  late final ActiveLiveNotifier _active;

  /// Null when the user is hosting another live and can't join this one.
  LiveRoomController? _c;
  LiveRoomController get c => _c!;
  StreamSubscription<String>? _notices;
  final _hearts = GlobalKey<HeartLayerState>();
  bool _composing = false;
  ChatLine? _replyTo;

  @override
  void initState() {
    super.initState();
    _active = ref.read(activeLiveProvider.notifier);
    _attach(widget.password);
  }

  void _attach(String? password) {
    _c = _active.attach(
      widget.roomId,
      hostSession: widget.hostSession,
      password: password,
    );
    if (_c == null) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (!mounted) return;
        showMessage(context, 'End your live before watching another');
        context.pop();
      });
      return;
    }
    c.addListener(_onChange);
    _notices = c.notices.listen((m) {
      if (mounted && (ModalRoute.of(context)?.isCurrent ?? false)) {
        showMessage(context, m);
      }
    });
  }

  void _detach() {
    final current = _c;
    if (current == null) return;
    unawaited(_notices?.cancel());
    current.removeListener(_onChange);
    _active.detach(current);
  }

  void _onChange() {
    if (!mounted) return;
    setState(() {});
    if (c.status == LiveStatus.kicked &&
        (ModalRoute.of(context)?.isCurrent ?? false)) {
      showMessage(context, 'You were removed from this live');
      context.pop();
    }
  }

  @override
  void dispose() {
    _detach();
    super.dispose();
  }

  /// Locked room: ask for the password and join again with it.
  Future<void> _unlock() async {
    final pw = await showRoomPasswordDialog(
      context,
      wrong: c.lockedOut?.wrong ?? false,
    );
    if (pw == null || !mounted) return;
    _detach();
    _active.close();
    setState(() => _attach(pw));
  }

  /// Leaving for good (the X), unlike back, which minimizes. Hosts confirm and end.
  Future<void> _leave() async {
    if (c.isHost && c.status != LiveStatus.ended) {
      if (!await confirmEndLive(context)) return;
      final summary = await _active.endHosting();
      if (!mounted) return;
      await showLiveSummary(context, summary);
    } else {
      _active.close();
    }
    if (mounted) context.pop();
  }

  void _openGifts([UserBrief? to]) {
    final d = c.detail;
    if (d == null) return;
    final onStage = <UserBrief>[
      d.room.host,
      ...c.stage.map((s) => s.user!).where((u) => u.id != d.room.host.id),
    ].where((u) => u.id != c.myUid).toList();
    if (to != null && to.id != c.myUid) {
      onStage
        ..removeWhere((u) => u.id == to.id)
        ..insert(0, to);
    }
    if (onStage.isEmpty) {
      return showMessage(
        context,
        'Gifts are for your guests and viewers to send',
      );
    }
    GiftPanel.show(context, roomId: widget.roomId, receivers: onStage);
  }

  void _openUser(UserBrief u) =>
      LiveUserSheet.show(context, c, u, onGift: _openGifts);

  void _openParticipants([int tab = 0]) =>
      ParticipantsSheet.show(context, c, onTapUser: _openUser, initialTab: tab);

  Future<void> _stageAction() async {
    try {
      if (c.onSeat) {
        final ok = await showDialog<bool>(
          context: context,
          builder: (ctx) => AlertDialog(
            title: const Text('Leave the stage?'),
            content: const Text('You’ll keep watching as a viewer.'),
            actions: [
              TextButton(
                onPressed: () => ctx.pop(false),
                child: const Text('Stay'),
              ),
              FilledButton(
                onPressed: () => ctx.pop(true),
                child: const Text('Leave'),
              ),
            ],
          ),
        );
        if (ok == true) await c.leaveSeat();
      } else if (c.seatRequestPending) {
        await c.cancelSeatRequest();
      } else {
        await c.requestSeat();
        if (mounted) showMessage(context, 'Request sent to the host');
      }
    } catch (e) {
      if (mounted) showError(context, e);
    }
  }

  void _heart() {
    _hearts.currentState?.burst();
    c.react();
  }

  @override
  Widget build(BuildContext context) {
    if (_c == null) {
      return const Scaffold(backgroundColor: BBColors.espresso);
    }
    final d = c.detail;
    final keyboard = MediaQuery.viewInsetsOf(context).bottom;
    // Back (button, gesture, predictive back) keeps the live going in the mini-player.
    return PopScope(
      canPop: !_composing,
      onPopInvokedWithResult: (didPop, _) {
        if (!didPop) return setState(() => _composing = false);
        _active.minimizeOrClose(c);
      },
      child: Scaffold(
        backgroundColor: BBColors.espresso,
        // The video must not jump when the keyboard opens; only the chat column moves.
        resizeToAvoidBottomInset: false,
        body: switch (c.status) {
          LiveStatus.connecting when d == null => const Center(
            child: CircularProgressIndicator(),
          ),
          LiveStatus.failed when c.lockedOut != null => _Ended(
            icon: Icons.lock_rounded,
            title: 'This live is locked',
            message: c.lockedOut!.hasPassword
                ? 'The host set a password for new viewers.'
                : 'The host isn’t letting new viewers in right now.',
            action: c.lockedOut!.hasPassword
                ? GoldButton(label: 'Enter password', onPressed: _unlock)
                : null,
          ),
          LiveStatus.failed => _Ended(
            title: 'Could not join',
            message: c.error ?? '',
          ),
          LiveStatus.ended when !c.isHost => const _Ended(
            title: 'This live has ended',
            message: 'Follow the host to know when they go live again.',
          ),
          _ => Stack(
            fit: StackFit.expand,
            children: [
              GestureDetector(
                onDoubleTap: _heart,
                onTap: _composing
                    ? () => setState(() => _composing = false)
                    : null,
                child: LiveStage(
                  c: c,
                  onTapUser: _openUser,
                  onTapEmptySeat: (s) => showEmptySeatSheet(
                    context,
                    c,
                    s,
                    onInvite: _openParticipants,
                  ),
                ),
              ),
              const Positioned(
                left: 0,
                right: 0,
                bottom: 0,
                height: 320,
                child: IgnorePointer(
                  child: DecoratedBox(
                    decoration: BoxDecoration(gradient: BBColors.videoScrim),
                  ),
                ),
              ),
              Positioned.fill(
                child: HeartLayer(key: _hearts, reactions: c.reactions),
              ),
              SafeArea(
                bottom: !_composing,
                child: Padding(
                  padding: EdgeInsets.only(bottom: _composing ? keyboard : 0),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      LiveTopBar(
                        c: c,
                        onClose: _leave,
                        onViewers: _openParticipants,
                        onTapUser: _openUser,
                      ),
                      LiveInfoRow(c: c),
                      PkWaitingBanner(c: c),
                      if (c.status == LiveStatus.reconnecting)
                        const _Pill(text: 'Reconnecting…'),
                      const Spacer(),
                      Padding(
                        padding: const EdgeInsets.only(left: 10, bottom: 6),
                        child: EntryBanner(entries: c.entries),
                      ),
                      LiveChatList(
                        c: c,
                        onTapUser: _openUser,
                        onReply: (line) => setState(() {
                          _replyTo = line;
                          _composing = true;
                        }),
                      ),
                      if (_composing)
                        ChatComposer(
                          c: c,
                          replyTo: _replyTo,
                          onClearReply: () => setState(() => _replyTo = null),
                          onClose: () => setState(() => _composing = false),
                        )
                      else
                        LiveBottomBar(
                          c: c,
                          onCompose: () => setState(() => _composing = true),
                          onGift: _openGifts,
                          onRequests: () =>
                              _openParticipants(ParticipantsSheet.requestsTab),
                          onStageAction: _stageAction,
                        ),
                    ],
                  ),
                ),
              ),
              if (!_composing)
                Positioned(
                  right: 10,
                  bottom: MediaQuery.paddingOf(context).bottom + 66,
                  child: LiveSideRail(
                    c: c,
                    onPk: () => PkPickerSheet.show(
                      context,
                      c,
                      ref.read(appConfigProvider).value?.pkDurations ??
                          const [60, 180, 300, 600],
                    ),
                    onLock: () => LockSheet.show(context, c),
                    onHeart: _heart,
                  ),
                ),
              Positioned.fill(child: EntryEffectOverlay(entries: c.entries)),
              Positioned.fill(child: GiftOverlay(gifts: c.gifts)),
            ],
          ),
        },
      ),
    );
  }
}

class _Pill extends StatelessWidget {
  const _Pill({required this.text});
  final String text;
  @override
  Widget build(BuildContext context) => Center(
    child: Container(
      margin: const EdgeInsets.only(top: 8),
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
      decoration: BoxDecoration(
        color: BBColors.scrim,
        borderRadius: BorderRadius.circular(12),
      ),
      child: Text(text, style: const TextStyle(color: BBColors.champagne)),
    ),
  );
}

class _Ended extends StatelessWidget {
  const _Ended({
    required this.title,
    required this.message,
    this.icon = Icons.videocam_off_rounded,
    this.action,
  });
  final String title;
  final String message;
  final IconData icon;
  final Widget? action;
  @override
  Widget build(BuildContext context) => SafeArea(
    child: Column(
      children: [
        Align(
          alignment: Alignment.topRight,
          child: IconButton(
            onPressed: () => context.pop(),
            icon: const Icon(Icons.close, color: BBColors.ivory),
          ),
        ),
        Expanded(
          child: Center(
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 32),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Icon(icon, color: BBColors.goldLight, size: 56),
                  const SizedBox(height: 16),
                  Text(
                    title,
                    textAlign: TextAlign.center,
                    style: Theme.of(context).textTheme.titleLarge
                        ?.copyWith(color: BBColors.ivory),
                  ),
                  const SizedBox(height: 8),
                  Text(
                    message,
                    textAlign: TextAlign.center,
                    style: const TextStyle(color: BBColors.champagne),
                  ),
                  if (action != null) ...[const SizedBox(height: 20), action!],
                ],
              ),
            ),
          ),
        ),
      ],
    ),
  );
}
