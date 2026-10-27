import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/providers.dart';
import '../../core/theme/bb_colors.dart';
import '../../core/utils/format.dart';
import '../../core/widgets/widgets.dart';
import '../../models/models.dart';
import '../profile/profile_screens.dart';
import 'live_room_controller.dart';

/// Host pill (with follow), top viewers, viewer count and close.
class LiveTopBar extends ConsumerWidget {
  const LiveTopBar({
    super.key,
    required this.c,
    required this.onClose,
    required this.onViewers,
    required this.onTapUser,
  });
  final LiveRoomController c;
  final VoidCallback onClose;
  final VoidCallback onViewers;
  final void Function(UserBrief user) onTapUser;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final host = c.detail!.room.host;
    return Padding(
      padding: const EdgeInsets.fromLTRB(10, 6, 4, 0),
      child: Row(
        children: [
          Flexible(
            child: GestureDetector(
              onTap: () => onTapUser(host),
              child: Container(
                padding: const EdgeInsets.fromLTRB(3, 3, 6, 3),
                decoration: BoxDecoration(
                  color: BBColors.scrim,
                  borderRadius: BorderRadius.circular(30),
                ),
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    BBAvatar(
                      url: host.avatarUrl,
                      name: host.displayName,
                      size: 34,
                      vip: host.vipTier > 0,
                      frameUrl: host.frameUrl,
                    ),
                    const SizedBox(width: 6),
                    Flexible(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            host.displayName,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: const TextStyle(
                              color: BBColors.ivory,
                              fontWeight: FontWeight.w700,
                              fontSize: 13,
                            ),
                          ),
                          Text(
                            'ID ${host.shortId}',
                            style: const TextStyle(
                              color: BBColors.champagne,
                              fontSize: 10,
                            ),
                          ),
                        ],
                      ),
                    ),
                    if (!c.isHost) ...[
                      const SizedBox(width: 6),
                      _FollowButton(uid: host.id),
                    ],
                  ],
                ),
              ),
            ),
          ),
          const SizedBox(width: 8),
          for (final v in c.topViewers)
            Padding(
              padding: const EdgeInsets.only(right: 2),
              child: GestureDetector(
                onTap: () => onTapUser(v),
                child: BBAvatar(
                  url: v.avatarUrl,
                  name: v.displayName,
                  size: 28,
                  vip: v.vipTier > 0,
                ),
              ),
            ),
          const SizedBox(width: 2),
          InkWell(
            onTap: onViewers,
            borderRadius: BorderRadius.circular(16),
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 5),
              decoration: BoxDecoration(
                color: BBColors.scrim,
                borderRadius: BorderRadius.circular(16),
              ),
              child: Row(
                children: [
                  const Icon(
                    Icons.person_outline_rounded,
                    size: 14,
                    color: BBColors.champagne,
                  ),
                  const SizedBox(width: 2),
                  Text(
                    Fmt.compact(c.viewerCount),
                    style: const TextStyle(
                      color: BBColors.ivory,
                      fontWeight: FontWeight.w700,
                      fontSize: 12,
                    ),
                  ),
                ],
              ),
            ),
          ),
          IconButton(
            tooltip: 'Close',
            onPressed: onClose,
            icon: const Icon(Icons.close_rounded, color: BBColors.ivory),
          ),
        ],
      ),
    );
  }
}

/// Follow + for the host pill; hidden once following.
class _FollowButton extends ConsumerStatefulWidget {
  const _FollowButton({required this.uid});
  final String uid;
  @override
  ConsumerState<_FollowButton> createState() => _FollowButtonState();
}

class _FollowButtonState extends ConsumerState<_FollowButton> {
  bool _busy = false;

  @override
  Widget build(BuildContext context) {
    final following =
        ref.watch(userProvider(widget.uid)).value?.isFollowing ?? false;
    if (following) return const SizedBox.shrink();
    return GestureDetector(
      onTap: _busy
          ? null
          : () async {
              setState(() => _busy = true);
              try {
                await ref.read(accountRepo).follow(widget.uid, true);
                ref.invalidate(userProvider(widget.uid));
              } catch (e) {
                if (context.mounted) showError(context, e);
              } finally {
                if (mounted) setState(() => _busy = false);
              }
            },
      child: Container(
        width: 26,
        height: 26,
        decoration: const BoxDecoration(
          shape: BoxShape.circle,
          gradient: BBColors.goldGradient,
        ),
        child: const Icon(Icons.add_rounded, size: 18, color: BBColors.ink),
      ),
    );
  }
}

/// Under the top bar: beans earned this live, elapsed time, the lock state and Report.
class LiveInfoRow extends StatelessWidget {
  const LiveInfoRow({super.key, required this.c});
  final LiveRoomController c;

  @override
  Widget build(BuildContext context) {
    final room = c.detail!.room;
    Widget chip(Widget child, {Color? border}) => Container(
      margin: const EdgeInsets.only(right: 6),
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
      decoration: BoxDecoration(
        color: BBColors.scrim,
        borderRadius: BorderRadius.circular(12),
        border: border == null ? null : Border.all(color: border),
      ),
      child: child,
    );
    const label = TextStyle(color: BBColors.ivory, fontSize: 11);
    return Padding(
      padding: const EdgeInsets.fromLTRB(10, 6, 10, 0),
      child: Row(
        children: [
          chip(
            Text(
              '🫘 ${Fmt.compact(room.giftBeans)}',
              style: label.copyWith(
                color: BBColors.goldLight,
                fontWeight: FontWeight.w700,
              ),
            ),
          ),
          if (room.startedAt != null)
            chip(_Elapsed(since: room.startedAt!, style: label)),
          if (room.locked)
            chip(
              Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  const Icon(
                    Icons.lock_rounded,
                    size: 12,
                    color: BBColors.goldLight,
                  ),
                  const SizedBox(width: 3),
                  Text(room.hasPassword ? 'Password' : 'Locked', style: label),
                ],
              ),
              border: BBColors.goldOutline,
            ),
          const Spacer(),
          if (!c.isHost)
            GestureDetector(
              onTap: () => ReportSheet.show(
                context,
                targetType: 'room',
                targetId: c.roomId,
              ),
              child: chip(
                const Text(
                  'Report',
                  style: TextStyle(
                    color: BBColors.ivory,
                    fontSize: 11,
                    fontWeight: FontWeight.w600,
                  ),
                ),
                border: BBColors.danger,
              ),
            ),
        ],
      ),
    );
  }
}

class _Elapsed extends StatefulWidget {
  const _Elapsed({required this.since, required this.style});
  final DateTime since;
  final TextStyle style;
  @override
  State<_Elapsed> createState() => _ElapsedState();
}

class _ElapsedState extends State<_Elapsed> {
  late final Timer _t = Timer.periodic(
    const Duration(seconds: 1),
    (_) => setState(() {}),
  );
  @override
  void dispose() {
    _t.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => Text(
    Fmt.clock(DateTime.now().difference(widget.since).inSeconds),
    style: widget.style.copyWith(
      fontFeatures: const [FontFeature.tabularFigures()],
    ),
  );
}

/// Round 36px button used on the side rail and bottom bar.
class LiveRoundButton extends StatelessWidget {
  const LiveRoundButton({
    super.key,
    required this.icon,
    required this.onTap,
    required this.tooltip,
    this.gold = false,
    this.danger = false,
    this.badge = 0,
    this.size = 40,
  });
  final IconData icon;
  final VoidCallback? onTap;
  final String tooltip;
  final bool gold;
  final bool danger;
  final int badge;
  final double size;

  @override
  Widget build(BuildContext context) => Tooltip(
    message: tooltip,
    child: InkWell(
      customBorder: const CircleBorder(),
      onTap: onTap,
      child: Stack(
        clipBehavior: Clip.none,
        children: [
          Container(
            width: size,
            height: size,
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              color: gold ? null : (danger ? BBColors.danger : BBColors.scrim),
              gradient: gold ? BBColors.goldGradient : null,
            ),
            child: Icon(
              icon,
              color: gold ? BBColors.ink : BBColors.ivory,
              size: size * 0.52,
            ),
          ),
          if (badge > 0)
            Positioned(
              right: -3,
              top: -3,
              child: Container(
                padding: const EdgeInsets.symmetric(horizontal: 5, vertical: 1),
                decoration: BoxDecoration(
                  color: BBColors.danger,
                  borderRadius: BorderRadius.circular(8),
                ),
                child: Text(
                  badge > 99 ? '99+' : '$badge',
                  style: const TextStyle(
                    color: BBColors.ivory,
                    fontSize: 10,
                    fontWeight: FontWeight.w800,
                  ),
                ),
              ),
            ),
        ],
      ),
    ),
  );
}

/// Right-hand column: PK (host), lock (host) and hearts (everyone).
class LiveSideRail extends ConsumerWidget {
  const LiveSideRail({
    super.key,
    required this.c,
    required this.onPk,
    required this.onLock,
    required this.onHeart,
  });
  final LiveRoomController c;
  final VoidCallback onPk;
  final VoidCallback onLock;
  final VoidCallback onHeart;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final pkEnabled =
        ref.watch(appConfigProvider).value?.feature('pkEnabled') ?? true;
    final canPk =
        c.isHost &&
        c.isVideoRoom &&
        pkEnabled &&
        c.pk == null &&
        c.pkOutgoing == null;
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        if (canPk) ...[
          LiveRoundButton(
            icon: Icons.bolt_rounded,
            tooltip: 'PK battle',
            gold: true,
            onTap: onPk,
          ),
          const SizedBox(height: 8),
        ],
        if (c.isHost) ...[
          LiveRoundButton(
            icon: c.locked ? Icons.lock_rounded : Icons.lock_open_rounded,
            tooltip: c.locked ? 'Unlock live' : 'Lock live',
            onTap: onLock,
          ),
          const SizedBox(height: 8),
        ],
        LiveRoundButton(
          icon: Icons.favorite_rounded,
          tooltip: 'Send hearts',
          onTap: onHeart,
        ),
      ],
    );
  }
}

/// Chat entry plus the role-specific actions: media toggles on stage, stage request /
/// leave for viewers and guests, the request inbox for the host and admins, and gifts.
class LiveBottomBar extends StatelessWidget {
  const LiveBottomBar({
    super.key,
    required this.c,
    required this.onCompose,
    required this.onGift,
    required this.onRequests,
    required this.onStageAction,
  });
  final LiveRoomController c;
  final VoidCallback onCompose;
  final VoidCallback onGift;
  final VoidCallback onRequests;
  final VoidCallback onStageAction;

  @override
  Widget build(BuildContext context) {
    final staged = c.isHost || c.onSeat;
    final compactChat = staged;
    final buttons = <Widget>[
      if (staged) ...[
        LiveRoundButton(
          icon: c.micOn ? Icons.mic_rounded : Icons.mic_off_rounded,
          tooltip: c.micOn ? 'Mute' : 'Unmute',
          danger: !c.micOn,
          onTap: c.toggleMic,
        ),
        if (c.isVideoRoom) ...[
          LiveRoundButton(
            icon: c.cameraOn
                ? Icons.videocam_rounded
                : Icons.videocam_off_rounded,
            tooltip: c.cameraOn ? 'Camera off' : 'Camera on',
            danger: !c.cameraOn,
            onTap: c.toggleCamera,
          ),
          if (c.cameraOn)
            LiveRoundButton(
              icon: Icons.cameraswitch_rounded,
              tooltip: 'Flip camera',
              onTap: c.flipCamera,
            ),
        ],
      ],
      if (!c.isHost)
        LiveRoundButton(
          icon: c.onSeat
              ? Icons.call_end_rounded
              : (c.seatRequestPending
                    ? Icons.call_end_rounded
                    : Icons.add_call),
          tooltip: c.onSeat
              ? 'Leave the stage'
              : (c.seatRequestPending
                    ? 'Cancel request'
                    : 'Ask to join the stage'),
          danger: c.onSeat || c.seatRequestPending,
          onTap: onStageAction,
        ),
      if (c.isModerator)
        LiveRoundButton(
          icon: Icons.groups_rounded,
          tooltip: 'Stage requests',
          badge: c.seatRequests.length,
          onTap: onRequests,
        ),
      LiveRoundButton(
        icon: Icons.card_giftcard_rounded,
        tooltip: 'Send a gift',
        gold: true,
        onTap: onGift,
      ),
    ];
    return Padding(
      padding: const EdgeInsets.fromLTRB(10, 4, 10, 10),
      child: Row(
        children: [
          if (compactChat)
            LiveRoundButton(
              icon: Icons.chat_bubble_outline_rounded,
              tooltip: 'Chat',
              onTap: onCompose,
            )
          else
            Expanded(
              child: GestureDetector(
                onTap: onCompose,
                child: Container(
                  height: 40,
                  padding: const EdgeInsets.symmetric(horizontal: 14),
                  alignment: Alignment.centerLeft,
                  decoration: BoxDecoration(
                    color: BBColors.scrim,
                    borderRadius: BorderRadius.circular(20),
                  ),
                  child: const Text(
                    'Say something…',
                    style: TextStyle(color: BBColors.inkSubtle),
                  ),
                ),
              ),
            ),
          if (compactChat) const Spacer(),
          for (final b in buttons) ...[const SizedBox(width: 8), b],
        ],
      ),
    );
  }
}
