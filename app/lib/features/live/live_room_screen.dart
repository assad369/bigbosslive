import 'dart:async';

import 'package:cached_network_image/cached_network_image.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:livekit_client/livekit_client.dart';

import '../../core/providers.dart';
import '../../core/theme/bb_colors.dart';
import '../../core/utils/format.dart';
import '../../core/utils/json.dart';
import '../../core/widgets/widgets.dart';
import '../../models/models.dart';
import '../profile/profile_screens.dart';
import 'gift_panel.dart';
import 'live_room_controller.dart';
import 'pk_widgets.dart';

class LiveRoomScreen extends ConsumerStatefulWidget {
  const LiveRoomScreen({super.key, required this.roomId, this.hostSession});
  final String roomId;
  final LiveSession? hostSession;

  @override
  ConsumerState<LiveRoomScreen> createState() => _LiveRoomScreenState();
}

class _LiveRoomScreenState extends ConsumerState<LiveRoomScreen> {
  late final LiveRoomController c;
  final _chat = TextEditingController();
  StreamSubscription<PkBattle>? _invites;

  @override
  void initState() {
    super.initState();
    c = LiveRoomController(
      roomId: widget.roomId,
      myUid: ref.read(meProvider).id,
      repo: ref.read(liveRepo),
      hostSession: widget.hostSession,
    );
    c.addListener(_onChange);
    _invites = c.pkInvites.listen(_onPkInvite);
    unawaited(c.start());
  }

  void _onChange() {
    if (!mounted) return;
    setState(() {});
    if (c.status == LiveStatus.kicked) {
      showMessage(context, 'You were removed from this live');
      context.pop();
    }
  }

  Future<void> _onPkInvite(PkBattle battle) async {
    final from = battle.hosts.first;
    final accept = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('PK challenge!'),
        content: Text(
          '${from.displayName} challenges you to a ${battle.durationSec ~/ 60}-minute PK.',
        ),
        actions: [
          TextButton(
            onPressed: () => ctx.pop(false),
            child: const Text('Decline'),
          ),
          FilledButton(
            onPressed: () => ctx.pop(true),
            child: const Text('Accept'),
          ),
        ],
      ),
    );
    try {
      await ref.read(liveRepo).pkRespond(battle.id, accept ?? false);
    } catch (e) {
      if (mounted) showError(context, e);
    }
  }

  @override
  void dispose() {
    _invites?.cancel();
    c.removeListener(_onChange);
    c.dispose();
    _chat.dispose();
    super.dispose();
  }

  Future<void> _leave() async {
    if (c.isHost) {
      final ok = await showDialog<bool>(
        context: context,
        builder: (ctx) => AlertDialog(
          title: const Text('End your live?'),
          actions: [
            TextButton(
              onPressed: () => ctx.pop(false),
              child: const Text('Keep going'),
            ),
            FilledButton(
              onPressed: () => ctx.pop(true),
              child: const Text('End live'),
            ),
          ],
        ),
      );
      if (ok != true) return;
      final summary = await c.end();
      if (!mounted) return;
      await _showSummary(summary);
    }
    if (mounted) context.pop();
  }

  Future<void> _showSummary(Json? s) => showDialog<void>(
    context: context,
    builder: (ctx) => AlertDialog(
      title: const Text('Live ended'),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          _SummaryRow('Duration', Fmt.duration(s?.integer('durationSec') ?? 0)),
          _SummaryRow('Peak viewers', Fmt.full(s?.integer('peakViewers') ?? 0)),
          _SummaryRow('Gifts', Fmt.full(s?.integer('giftCount') ?? 0)),
          _SummaryRow(
            'Beans earned',
            '🫘 ${Fmt.full(s?.integer('giftBeans') ?? 0)}',
          ),
        ],
      ),
      actions: [
        FilledButton(onPressed: () => ctx.pop(), child: const Text('Done')),
      ],
    ),
  );

  void _openGifts() {
    final d = c.detail;
    if (d == null) return;
    final receivers = <UserBrief>[
      d.room.host,
      ...d.seats
          .map((s) => s.user)
          .whereType<UserBrief>()
          .where((u) => u.id != d.room.host.id),
    ].where((u) => u.id != c.myUid).toList();
    if (receivers.isEmpty) {
      return showMessage(
        context,
        'Gifts are for your guests and viewers to send',
      );
    }
    GiftPanel.show(context, roomId: widget.roomId, receivers: receivers);
  }

  Future<void> _openViewers() async {
    final viewers = await ref
        .read(liveRepo)
        .viewers(widget.roomId)
        .catchError((Object _) => <UserBrief>[]);
    if (!mounted) return;
    await showModalBottomSheet<void>(
      context: context,
      builder: (ctx) => ListView(
        children: [
          Padding(
            padding: const EdgeInsets.all(16),
            child: Text(
              '${viewers.length} watching',
              style: Theme.of(ctx).textTheme.titleMedium,
            ),
          ),
          for (final v in viewers)
            UserTile(
              user: v,
              onTap: () => _openUserCard(v),
              trailing: c.isModerator && v.id != c.myUid
                  ? IconButton(
                      tooltip: 'Remove',
                      icon: const Icon(Icons.person_remove_alt_1_outlined),
                      onPressed: () async {
                        await c.kick(v.id);
                        if (ctx.mounted) ctx.pop();
                      },
                    )
                  : null,
            ),
        ],
      ),
    );
  }

  void _openUserCard(UserBrief u) => UserCardSheet.show(
    context,
    u,
    roomId: widget.roomId,
    canModerate:
        c.isModerator && u.id != c.myUid && u.id != c.detail?.room.host.id,
  );

  Future<void> _hostTools() async {
    final pkDurations =
        ref.read(appConfigProvider).value?.pkDurations ?? const [180, 300, 600];
    await showModalBottomSheet<void>(
      context: context,
      builder: (ctx) => SafeArea(
        child: Wrap(
          children: [
            if (!(c.detail?.room.isAudio ?? false)) ...[
              ListTile(
                leading: const Icon(Icons.cameraswitch_outlined),
                title: const Text('Flip camera'),
                onTap: () => ctx.pop(c.flipCamera()),
              ),
              ListTile(
                leading: Icon(
                  c.cameraOn
                      ? Icons.videocam_off_outlined
                      : Icons.videocam_outlined,
                ),
                title: Text(c.cameraOn ? 'Turn camera off' : 'Turn camera on'),
                onTap: () => ctx.pop(c.toggleCamera()),
              ),
            ],
            ListTile(
              leading: Icon(c.micOn ? Icons.mic_off_outlined : Icons.mic_none),
              title: Text(c.micOn ? 'Mute microphone' : 'Unmute microphone'),
              onTap: () => ctx.pop(c.toggleMic()),
            ),
            ListTile(
              leading: const Icon(Icons.event_seat_outlined),
              title: const Text('Seat requests'),
              onTap: () => ctx.pop(_seatRequests()),
            ),
            if (!(c.detail?.room.isAudio ?? false) && c.pk == null)
              ListTile(
                leading: const Icon(
                  Icons.bolt_rounded,
                  color: BBColors.goldDeep,
                ),
                title: const Text('Start a random PK'),
                onTap: () =>
                    ctx.pop(PkLauncher.start(context, ref, pkDurations)),
              ),
            if (c.pk?.isActive ?? false)
              ListTile(
                leading: const Icon(Icons.flag_outlined),
                title: const Text('Forfeit PK'),
                onTap: () => ctx.pop(ref.read(liveRepo).pkEnd(c.pk!.id)),
              ),
          ],
        ),
      ),
    );
  }

  Future<void> _seatRequests() async {
    final requests = await ref
        .read(liveRepo)
        .seatRequests(widget.roomId)
        .catchError((Object _) => <UserBrief>[]);
    if (!mounted) return;
    await showModalBottomSheet<void>(
      context: context,
      builder: (ctx) => requests.isEmpty
          ? const EmptyState(
              icon: Icons.event_seat_outlined,
              title: 'No seat requests',
            )
          : ListView(
              children: [
                for (final u in requests)
                  UserTile(
                    user: u,
                    trailing: Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        IconButton(
                          icon: const Icon(Icons.close),
                          onPressed: () => ctx.pop(
                            ref
                                .read(liveRepo)
                                .decideSeat(widget.roomId, u.id, false),
                          ),
                        ),
                        IconButton(
                          icon: const Icon(
                            Icons.check_circle,
                            color: BBColors.success,
                          ),
                          onPressed: () => ctx.pop(
                            ref
                                .read(liveRepo)
                                .decideSeat(widget.roomId, u.id, true),
                          ),
                        ),
                      ],
                    ),
                  ),
              ],
            ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final d = c.detail;
    return PopScope(
      canPop: !c.isHost || c.status != LiveStatus.live,
      onPopInvokedWithResult: (didPop, _) {
        if (!didPop) unawaited(_leave());
      },
      child: Scaffold(
        backgroundColor: BBColors.espresso,
        resizeToAvoidBottomInset: true,
        body: switch (c.status) {
          LiveStatus.connecting when d == null => const Center(
            child: CircularProgressIndicator(),
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
              _Stage(c: c),
              const Positioned(
                left: 0,
                right: 0,
                bottom: 0,
                height: 320,
                child: DecoratedBox(
                  decoration: BoxDecoration(gradient: BBColors.videoScrim),
                ),
              ),
              SafeArea(
                child: Column(
                  children: [
                    _TopBar(c: c, onClose: _leave, onViewers: _openViewers),
                    if (c.pk != null)
                      PkScoreBar(
                        battle: c.pk!,
                        hostUid: d!.room.host.id,
                        contributors: c.pkContributors,
                      ),
                    if (c.status == LiveStatus.reconnecting)
                      Container(
                        margin: const EdgeInsets.only(top: 8),
                        padding: const EdgeInsets.symmetric(
                          horizontal: 12,
                          vertical: 4,
                        ),
                        decoration: BoxDecoration(
                          color: BBColors.scrim,
                          borderRadius: BorderRadius.circular(12),
                        ),
                        child: const Text(
                          'Reconnecting…',
                          style: TextStyle(color: BBColors.champagne),
                        ),
                      ),
                    const Spacer(),
                    _ChatList(lines: c.chat, onTapUser: _openUserCard),
                    _BottomBar(
                      c: c,
                      controller: _chat,
                      onGift: _openGifts,
                      onHostTools: _hostTools,
                      onSeat: () async {
                        try {
                          if (c.onSeat) {
                            await c.leaveSeat();
                          } else {
                            await c.requestSeat();
                            if (context.mounted) {
                              showMessage(context, 'Request sent to the host');
                            }
                          }
                        } catch (e) {
                          if (context.mounted) showError(context, e);
                        }
                      },
                    ),
                  ],
                ),
              ),
              Positioned.fill(child: GiftOverlay(gifts: c.gifts)),
            ],
          ),
        },
      ),
    );
  }
}

class _SummaryRow extends StatelessWidget {
  const _SummaryRow(this.label, this.value);
  final String label;
  final String value;
  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.symmetric(vertical: 6),
    child: Row(
      children: [
        Text(label, style: const TextStyle(color: BBColors.inkMuted)),
        const Spacer(),
        Text(value, style: const TextStyle(fontWeight: FontWeight.w700)),
      ],
    ),
  );
}

class _Ended extends StatelessWidget {
  const _Ended({required this.title, required this.message});
  final String title;
  final String message;
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
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                const Icon(
                  Icons.videocam_off_rounded,
                  color: BBColors.goldLight,
                  size: 56,
                ),
                const SizedBox(height: 16),
                Text(
                  title,
                  style: Theme.of(context).textTheme.titleLarge
                      ?.copyWith(color: BBColors.ivory),
                ),
                const SizedBox(height: 8),
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 32),
                  child: Text(
                    message,
                    textAlign: TextAlign.center,
                    style: const TextStyle(color: BBColors.champagne),
                  ),
                ),
              ],
            ),
          ),
        ),
      ],
    ),
  );
}

/// Video stage: host full-screen, PK split-screen, or the audio-room seat grid.
class _Stage extends StatelessWidget {
  const _Stage({required this.c});
  final LiveRoomController c;

  @override
  Widget build(BuildContext context) {
    final d = c.detail!;
    final background = d.backgroundUrl ?? d.room.coverUrl;
    if (d.room.isAudio) {
      return Stack(
        fit: StackFit.expand,
        children: [
          if (background != null)
            CachedNetworkImage(
              imageUrl: background,
              fit: BoxFit.cover,
              color: const Color(0xAA1D1610),
              colorBlendMode: BlendMode.darken,
            ),
          SafeArea(
            child: Padding(
              padding: const EdgeInsets.only(top: 90),
              child: SeatGrid(c: c),
            ),
          ),
        ],
      );
    }
    Widget video(VideoTrack? track, {bool mirror = false}) => track == null
        ? (background == null
              ? const ColoredBox(color: BBColors.espresso)
              : CachedNetworkImage(imageUrl: background, fit: BoxFit.cover))
        : VideoTrackRenderer(
            track,
            fit: VideoViewFit.cover,
            mirrorMode: mirror
                ? VideoViewMirrorMode.mirror
                : VideoViewMirrorMode.off,
          );

    if (c.pk != null) {
      return Column(
        children: [
          SizedBox(height: MediaQuery.paddingOf(context).top + 96),
          AspectRatio(
            aspectRatio: 1.2,
            child: Row(
              children: [
                Expanded(
                  child: video(c.hostVideo, mirror: c.isHost && c.frontCamera),
                ),
                const VerticalDivider(width: 2, color: BBColors.gold),
                Expanded(child: video(c.opponentVideo)),
              ],
            ),
          ),
          const Expanded(child: ColoredBox(color: BBColors.espresso)),
        ],
      );
    }
    final guests = d.seats.where((s) => s.index > 0 && s.user != null).toList();
    return Stack(
      fit: StackFit.expand,
      children: [
        video(c.hostVideo, mirror: c.isHost && c.frontCamera),
        if (guests.isNotEmpty)
          Positioned(
            right: 8,
            top: MediaQuery.paddingOf(context).top + 110,
            child: Column(
              children: [
                for (final s in guests)
                  Container(
                    width: 96,
                    height: 128,
                    margin: const EdgeInsets.only(bottom: 8),
                    decoration: BoxDecoration(
                      border: Border.all(color: BBColors.goldLight),
                      borderRadius: BorderRadius.circular(12),
                    ),
                    clipBehavior: Clip.antiAlias,
                    child:
                        c.room.remoteParticipants.values.any(
                              (p) => p.identity == s.user!.id,
                            ) ||
                            s.user!.id == c.myUid
                        ? video(
                            s.user!.id == c.myUid
                                ? c
                                      .room
                                      .localParticipant
                                      ?.videoTrackPublications
                                      .firstOrNull
                                      ?.track
                                : c.room.remoteParticipants.values
                                      .firstWhere(
                                        (p) => p.identity == s.user!.id,
                                      )
                                      .videoTrackPublications
                                      .firstOrNull
                                      ?.track,
                          )
                        : Center(
                            child: BBAvatar(
                              url: s.user!.avatarUrl,
                              name: s.user!.displayName,
                            ),
                          ),
                  ),
              ],
            ),
          ),
      ],
    );
  }
}

class SeatGrid extends StatelessWidget {
  const SeatGrid({super.key, required this.c});
  final LiveRoomController c;

  @override
  Widget build(BuildContext context) {
    final seats = c.detail!.seats;
    return GridView.count(
      crossAxisCount: 4,
      padding: const EdgeInsets.symmetric(horizontal: 16),
      shrinkWrap: true,
      physics: const NeverScrollableScrollPhysics(),
      childAspectRatio: 0.78,
      children: [
        for (final s in seats)
          Column(
            children: [
              AnimatedContainer(
                duration: const Duration(milliseconds: 200),
                padding: const EdgeInsets.all(3),
                decoration: BoxDecoration(
                  shape: BoxShape.circle,
                  boxShadow: s.user != null && c.isSpeaking(s.user!.id)
                      ? const [
                          BoxShadow(
                            color: BBColors.goldLight,
                            blurRadius: 14,
                            spreadRadius: 2,
                          ),
                        ]
                      : null,
                ),
                child: s.user != null
                    ? BBAvatar(
                        url: s.user!.avatarUrl,
                        name: s.user!.displayName,
                        size: 58,
                        vip: s.index == 0 || s.user!.vipTier > 0,
                        frameUrl: s.user!.frameUrl,
                      )
                    : Container(
                        width: 58,
                        height: 58,
                        decoration: BoxDecoration(
                          shape: BoxShape.circle,
                          color: const Color(0x22F3E5C3),
                          border: Border.all(color: const Color(0x55E9CF7A)),
                        ),
                        child: Icon(
                          s.locked
                              ? Icons.lock_outline
                              : Icons.event_seat_outlined,
                          color: BBColors.champagne,
                          size: 22,
                        ),
                      ),
              ),
              const SizedBox(height: 4),
              Text(
                s.user?.displayName ??
                    (s.index == 0 ? 'Host' : 'Seat ${s.index}'),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(color: BBColors.ivory, fontSize: 11),
              ),
              if (s.muted)
                const Icon(Icons.mic_off, size: 12, color: BBColors.danger),
            ],
          ),
      ],
    );
  }
}

class _TopBar extends ConsumerWidget {
  const _TopBar({
    required this.c,
    required this.onClose,
    required this.onViewers,
  });
  final LiveRoomController c;
  final VoidCallback onClose;
  final VoidCallback onViewers;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final host = c.detail!.room.host;
    return Padding(
      padding: const EdgeInsets.fromLTRB(10, 6, 6, 0),
      child: Row(
        children: [
          GestureDetector(
            onTap: () => UserCardSheet.show(context, host, roomId: c.roomId),
            child: Container(
              padding: const EdgeInsets.fromLTRB(3, 3, 10, 3),
              decoration: BoxDecoration(
                color: BBColors.scrim,
                borderRadius: BorderRadius.circular(30),
              ),
              child: Row(
                children: [
                  BBAvatar(
                    url: host.avatarUrl,
                    name: host.displayName,
                    size: 34,
                    vip: host.vipTier > 0,
                  ),
                  const SizedBox(width: 8),
                  Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      ConstrainedBox(
                        constraints: const BoxConstraints(maxWidth: 110),
                        child: Text(
                          host.displayName,
                          overflow: TextOverflow.ellipsis,
                          style: const TextStyle(
                            color: BBColors.ivory,
                            fontWeight: FontWeight.w700,
                            fontSize: 13,
                          ),
                        ),
                      ),
                      Text(
                        '🫘 ${Fmt.compact(c.detail!.room.giftBeans)}',
                        style: const TextStyle(
                          color: BBColors.goldLight,
                          fontSize: 11,
                        ),
                      ),
                    ],
                  ),
                  if (!c.isHost) ...[
                    const SizedBox(width: 8),
                    _FollowPill(uid: host.id),
                  ],
                ],
              ),
            ),
          ),
          const Spacer(),
          InkWell(
            onTap: onViewers,
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
              decoration: BoxDecoration(
                color: BBColors.scrim,
                borderRadius: BorderRadius.circular(20),
              ),
              child: Row(
                children: [
                  const Icon(
                    Icons.remove_red_eye_outlined,
                    size: 14,
                    color: BBColors.champagne,
                  ),
                  const SizedBox(width: 4),
                  Text(
                    Fmt.compact(c.viewerCount),
                    style: const TextStyle(
                      color: BBColors.ivory,
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                ],
              ),
            ),
          ),
          IconButton(
            onPressed: onClose,
            icon: const Icon(Icons.close_rounded, color: BBColors.ivory),
          ),
        ],
      ),
    );
  }
}

class _FollowPill extends ConsumerStatefulWidget {
  const _FollowPill({required this.uid});
  final String uid;
  @override
  ConsumerState<_FollowPill> createState() => _FollowPillState();
}

class _FollowPillState extends ConsumerState<_FollowPill> {
  bool _done = false;
  @override
  Widget build(BuildContext context) => _done
      ? const SizedBox.shrink()
      : GestureDetector(
          onTap: () async {
            setState(() => _done = true);
            await ref
                .read(accountRepo)
                .follow(widget.uid, true)
                .catchError((Object _) => setState(() => _done = false));
          },
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
            decoration: BoxDecoration(
              gradient: BBColors.goldGradient,
              borderRadius: BorderRadius.circular(14),
            ),
            child: const Text(
              'Follow',
              style: TextStyle(
                color: BBColors.ink,
                fontWeight: FontWeight.w800,
                fontSize: 12,
              ),
            ),
          ),
        );
}

class _ChatList extends StatelessWidget {
  const _ChatList({required this.lines, required this.onTapUser});
  final List<ChatLine> lines;
  final void Function(UserBrief) onTapUser;

  @override
  Widget build(BuildContext context) => SizedBox(
    height: 220,
    child: ShaderMask(
      shaderCallback: (r) => const LinearGradient(
        begin: Alignment.topCenter,
        end: Alignment.bottomCenter,
        colors: [Colors.transparent, Colors.black],
        stops: [0, 0.18],
      ).createShader(r),
      blendMode: BlendMode.dstIn,
      child: ListView.builder(
        reverse: true,
        padding: const EdgeInsets.fromLTRB(10, 0, 90, 4),
        itemCount: lines.length,
        itemBuilder: (_, i) {
          final line = lines[lines.length - 1 - i];
          return Align(
            alignment: Alignment.centerLeft,
            child: Container(
              margin: const EdgeInsets.only(bottom: 4),
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
              decoration: BoxDecoration(
                color: line.system ? const Color(0x33E9CF7A) : BBColors.scrim,
                borderRadius: BorderRadius.circular(14),
              ),
              child: line.system
                  ? Text(
                      line.text,
                      style: const TextStyle(
                        color: BBColors.goldLight,
                        fontSize: 12,
                      ),
                    )
                  : GestureDetector(
                      onTap: line.user == null
                          ? null
                          : () => onTapUser(line.user!),
                      child: Text.rich(
                        TextSpan(
                          children: [
                            if (line.user != null)
                              WidgetSpan(
                                alignment: PlaceholderAlignment.middle,
                                child: Padding(
                                  padding: const EdgeInsets.only(right: 4),
                                  child: LevelBadge(
                                    line.user!.level,
                                    dense: true,
                                  ),
                                ),
                              ),
                            TextSpan(
                              text: '${line.user?.displayName ?? ''}: ',
                              style: const TextStyle(
                                color: BBColors.goldLight,
                                fontWeight: FontWeight.w700,
                                fontSize: 13,
                              ),
                            ),
                            TextSpan(
                              text: line.text,
                              style: const TextStyle(
                                color: BBColors.ivory,
                                fontSize: 13,
                              ),
                            ),
                          ],
                        ),
                      ),
                    ),
            ),
          );
        },
      ),
    ),
  );
}

class _BottomBar extends StatelessWidget {
  const _BottomBar({
    required this.c,
    required this.controller,
    required this.onGift,
    required this.onHostTools,
    required this.onSeat,
  });
  final LiveRoomController c;
  final TextEditingController controller;
  final VoidCallback onGift;
  final VoidCallback onHostTools;
  final VoidCallback onSeat;

  @override
  Widget build(BuildContext context) {
    Widget round(
      IconData icon,
      VoidCallback onTap, {
      bool gold = false,
      String? tooltip,
    }) => Padding(
      padding: const EdgeInsets.only(left: 8),
      child: Tooltip(
        message: tooltip ?? '',
        child: InkWell(
          customBorder: const CircleBorder(),
          onTap: onTap,
          child: Container(
            width: 42,
            height: 42,
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              color: gold ? null : BBColors.scrim,
              gradient: gold ? BBColors.goldGradient : null,
            ),
            child: Icon(
              icon,
              color: gold ? BBColors.ink : BBColors.ivory,
              size: 22,
            ),
          ),
        ),
      ),
    );
    return Padding(
      padding: const EdgeInsets.fromLTRB(10, 4, 10, 10),
      child: Row(
        children: [
          Expanded(
            child: Container(
              height: 42,
              padding: const EdgeInsets.symmetric(horizontal: 14),
              decoration: BoxDecoration(
                color: BBColors.scrim,
                borderRadius: BorderRadius.circular(22),
              ),
              child: TextField(
                controller: controller,
                maxLength: 300,
                style: const TextStyle(color: BBColors.ivory),
                cursorColor: BBColors.goldLight,
                textInputAction: TextInputAction.send,
                decoration: const InputDecoration(
                  border: InputBorder.none,
                  enabledBorder: InputBorder.none,
                  focusedBorder: InputBorder.none,
                  filled: false,
                  counterText: '',
                  hintText: 'Say something…',
                  hintStyle: TextStyle(color: BBColors.inkSubtle),
                  isDense: true,
                ),
                onSubmitted: (v) async {
                  controller.clear();
                  try {
                    await c.sendChat(v);
                  } catch (e) {
                    if (context.mounted) showError(context, e);
                  }
                },
              ),
            ),
          ),
          if (c.isHost)
            round(Icons.tune_rounded, onHostTools, tooltip: 'Host tools'),
          if (!c.isHost)
            round(
              c.onSeat ? Icons.event_seat : Icons.event_seat_outlined,
              onSeat,
              tooltip: c.onSeat ? 'Leave seat' : 'Request a seat',
            ),
          if (c.onSeat)
            round(
              c.micOn ? Icons.mic_rounded : Icons.mic_off_rounded,
              c.toggleMic,
              tooltip: 'Microphone',
            ),
          round(
            Icons.card_giftcard_rounded,
            onGift,
            gold: true,
            tooltip: 'Send a gift',
          ),
        ],
      ),
    );
  }
}
