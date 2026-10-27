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

/// Host pill (with follow) on the left; top viewers, viewer count and close in the
/// right-hand corner.
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
      padding: const EdgeInsets.fromLTRB(10, 6, 10, 0),
      child: LayoutBuilder(
        builder: (context, box) => Row(
          children: [
            Expanded(
              child: Align(
                alignment: Alignment.centerLeft,
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
            ),
            const SizedBox(width: 6),
            // A share of the width, so a busy room never squeezes the host pill.
            ConstrainedBox(
              constraints: BoxConstraints(maxWidth: box.maxWidth * 0.3),
              child: _TopViewers(
                viewers: [
                  for (final v in c.topViewers)
                    if (v.id != host.id) v,
                ],
                onTapUser: onTapUser,
              ),
            ),
            const SizedBox(width: 4),
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
            _CloseButton(
              label: c.isHost ? 'End live' : 'Leave',
              onTap: onClose,
            ),
          ],
        ),
      ),
    );
  }
}

/// The highest-ranked viewers (VIP tier, then level, as the server sorts them). Scrolls
/// sideways when it is given less room than it needs.
class _TopViewers extends StatelessWidget {
  const _TopViewers({required this.viewers, required this.onTapUser});
  final List<UserBrief> viewers;
  final void Function(UserBrief user) onTapUser;

  static const _size = 30.0;

  @override
  Widget build(BuildContext context) {
    if (viewers.isEmpty) return const SizedBox.shrink();
    return SingleChildScrollView(
      scrollDirection: Axis.horizontal,
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          for (final v in viewers)
            GestureDetector(
              onTap: () => onTapUser(v),
              child: Tooltip(
                message: v.displayName,
                // Room around the avatar for its frame and the VIP tag.
                child: SizedBox(
                  width: _size + 6,
                  height: _size + 10,
                  child: Stack(
                    alignment: Alignment.topCenter,
                    children: [
                      Positioned(
                        top: 4,
                        child: BBAvatar(
                          url: v.avatarUrl,
                          name: v.displayName,
                          size: _size,
                          vip: v.vipTier > 0,
                          frameUrl: v.frameUrl,
                        ),
                      ),
                      if (v.vipTier > 0)
                        Positioned(bottom: 0, child: _VipTag(v.vipTier)),
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

/// A compact VIP marker for small avatars; [VipBadge] is too wide here.
class _VipTag extends StatelessWidget {
  const _VipTag(this.tier);
  final int tier;

  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.symmetric(horizontal: 3),
    decoration: BoxDecoration(
      color: BBColors.ink,
      borderRadius: BorderRadius.circular(6),
      border: Border.all(color: BBColors.gold, width: 0.8),
    ),
    child: Text(
      'VIP$tier',
      style: const TextStyle(
        color: BBColors.goldLight,
        fontSize: 7,
        fontWeight: FontWeight.w800,
        height: 1.3,
      ),
    ),
  );
}

/// Close in the top-right corner: a 30px disc with a full-size touch target.
class _CloseButton extends StatelessWidget {
  const _CloseButton({required this.label, required this.onTap});
  final String label;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) => Tooltip(
    message: label,
    child: InkResponse(
      onTap: onTap,
      radius: 22,
      child: SizedBox(
        width: 38,
        height: 40,
        child: Align(
          alignment: Alignment.centerRight,
          child: Container(
            width: 30,
            height: 30,
            decoration: const BoxDecoration(
              shape: BoxShape.circle,
              color: BBColors.scrim,
            ),
            child: const Icon(
              Icons.close_rounded,
              size: 18,
              color: BBColors.ivory,
            ),
          ),
        ),
      ),
    ),
  );
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
            chip(
              LiveElapsed(
                since: room.startedAt!,
                offset: c.detail!.clockOffset,
                style: label,
              ),
            ),
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

/// Time since [since] (a server instant), ticking on each whole second. It is anchored
/// once and then counts on a monotonic stopwatch, so a device clock change mid-stream
/// can't make it jump.
class LiveElapsed extends StatefulWidget {
  const LiveElapsed({
    super.key,
    required this.since,
    this.offset = Duration.zero,
    this.style,
  });
  final DateTime since;

  /// Server − device clock (see [RoomDetail.clockOffset]).
  final Duration offset;
  final TextStyle? style;

  @override
  State<LiveElapsed> createState() => _LiveElapsedState();
}

class _LiveElapsedState extends State<LiveElapsed> {
  final _watch = Stopwatch();
  Duration _base = Duration.zero;
  Timer? _tick;

  Duration get _elapsed => _base + _watch.elapsed;

  @override
  void initState() {
    super.initState();
    _anchor();
  }

  @override
  void didUpdateWidget(LiveElapsed old) {
    super.didUpdateWidget(old);
    // Detail polls re-estimate the offset with fresh network jitter; only a real change
    // (a new room, or a clock that moved) re-anchors.
    if (old.since != widget.since ||
        (old.offset - widget.offset).abs() > const Duration(seconds: 2)) {
      _anchor();
    }
  }

  void _anchor() {
    _base = DateTime.now().add(widget.offset).difference(widget.since);
    _watch
      ..reset()
      ..start();
    _schedule();
  }

  /// One-shot timers aimed at the next second boundary don't drift the way a periodic
  /// timer started mid-second would.
  void _schedule() {
    _tick?.cancel();
    final ms = _elapsed.inMilliseconds;
    _tick = Timer(Duration(milliseconds: 1000 - ms % 1000), () {
      if (!mounted) return;
      setState(() {});
      _schedule();
    });
  }

  @override
  void dispose() {
    _tick?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => Text(
    Fmt.clock(_elapsed.inSeconds),
    style: (widget.style ?? const TextStyle()).copyWith(
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

/// Right-hand column: PK (host), lock (host), flip camera (on stage, camera on) and hearts
/// (everyone).
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
    final canFlip = (c.isHost || c.onSeat) && c.isVideoRoom && c.cameraOn;
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
        if (canFlip) ...[
          LiveRoundButton(
            icon: Icons.cameraswitch_rounded,
            tooltip: 'Flip camera',
            onTap: c.flipCamera,
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

/// Chat field plus the role-specific actions: media toggles on stage, stage request /
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

  /// The chat field never gets narrower than this; a crowded bar shrinks its buttons.
  static const _minField = 110.0;
  static const _gap = 8.0;

  List<Widget> _buttons(double size) {
    final staged = c.isHost || c.onSeat;
    return [
      if (staged) ...[
        LiveRoundButton(
          icon: c.micOn ? Icons.mic_rounded : Icons.mic_off_rounded,
          tooltip: c.micOn ? 'Mute' : 'Unmute',
          danger: !c.micOn,
          size: size,
          onTap: c.toggleMic,
        ),
        if (c.isVideoRoom)
          LiveRoundButton(
            icon: c.cameraOn
                ? Icons.videocam_rounded
                : Icons.videocam_off_rounded,
            tooltip: c.cameraOn ? 'Camera off' : 'Camera on',
            danger: !c.cameraOn,
            size: size,
            onTap: c.toggleCamera,
          ),
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
          size: size,
          onTap: onStageAction,
        ),
      if (c.isModerator)
        LiveRoundButton(
          icon: Icons.groups_rounded,
          tooltip: 'Stage requests',
          badge: c.seatRequests.length,
          size: size,
          onTap: onRequests,
        ),
      LiveRoundButton(
        icon: Icons.card_giftcard_rounded,
        tooltip: 'Send a gift',
        gold: true,
        size: size,
        onTap: onGift,
      ),
    ];
  }

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.fromLTRB(10, 4, 10, 10),
    child: LayoutBuilder(
      builder: (context, box) {
        final count = _buttons(40).length;
        final size = box.maxWidth - count * (40 + _gap) >= _minField
            ? 40.0
            : 34.0;
        return Row(
          children: [
            Expanded(child: _ChatField(onTap: onCompose)),
            for (final b in _buttons(size)) ...[const SizedBox(width: _gap), b],
          ],
        );
      },
    ),
  );
}

/// Looks like the composer's text field; tapping opens it with the keyboard up.
class _ChatField extends StatelessWidget {
  const _ChatField({required this.onTap});
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) => Semantics(
    button: true,
    label: 'Write a message',
    excludeSemantics: true,
    child: GestureDetector(
      behavior: HitTestBehavior.opaque,
      onTap: onTap,
      child: Container(
        height: 40,
        padding: const EdgeInsets.symmetric(horizontal: 12),
        decoration: BoxDecoration(
          color: BBColors.scrim,
          borderRadius: BorderRadius.circular(20),
        ),
        child: const Row(
          children: [
            Icon(
              Icons.chat_bubble_outline_rounded,
              size: 16,
              color: BBColors.inkSubtle,
            ),
            SizedBox(width: 6),
            Expanded(
              child: Text(
                'Say something…',
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(color: BBColors.inkSubtle),
              ),
            ),
          ],
        ),
      ),
    ),
  );
}
