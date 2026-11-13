import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/providers.dart';
import '../../core/theme/bb_colors.dart';
import '../../core/utils/format.dart';
import '../../core/widgets/wallet_balance.dart';
import '../../core/widgets/widgets.dart';
import '../../models/models.dart';
import '../profile/profile_screens.dart';
import 'camera_filter_channel.dart';
import 'live_room_controller.dart';

/// The live room's header, two rows:
///  1. the host (name, live timer under it, Follow for viewers), the top viewers, the
///     speaker toggle and the gold close button;
///  2. a stats card: diamonds this live, viewers (tap for the list), the lock, the host's ID.
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

  static const _rowHeight = 48.0;
  static const _gap = 6.0;

  /// Both rows with their padding; the stage starts below it.
  static const height = _gap + _rowHeight + _gap + _StatsCard.height + _gap;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final host = c.detail!.room.host;
    // Fixed-height chrome over the stage: very large text stops growing at 1.3×.
    return MediaQuery.withClampedTextScaling(
      maxScaleFactor: 1.3,
      child: SizedBox(
        height: height,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(12, _gap, 8, _gap),
          child: Column(
            children: [
              SizedBox(
                height: _rowHeight,
                child: Row(
                  children: [
                    Flexible(
                      flex: 0,
                      child: _HostChip(
                        c: c,
                        host: host,
                        onTap: () => onTapUser(host),
                      ),
                    ),
                    Expanded(
                      child: _TopViewers(
                        viewers: [
                          for (final v in c.topViewers)
                            if (v.id != host.id) v,
                        ],
                        onTapUser: onTapUser,
                      ),
                    ),
                    Semantics(
                      toggled: !c.roomAudioOn,
                      child: IconButton(
                        tooltip: c.roomAudioOn
                            ? 'Mute room audio'
                            : 'Unmute room audio',
                        onPressed: c.toggleRoomAudio,
                        icon: Icon(
                          c.roomAudioOn
                              ? Icons.volume_up_rounded
                              : Icons.volume_off_rounded,
                          size: 26,
                          color: BBColors.ivory,
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
              const SizedBox(height: _gap),
              Padding(
                padding: const EdgeInsets.only(right: 4),
                child: _StatsCard(c: c, onViewers: onViewers),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// The host's avatar with their name and the live timer under it, then Follow for
/// viewers. A long name ends in an ellipsis so the viewers keep some room.
class _HostChip extends StatelessWidget {
  const _HostChip({required this.c, required this.host, required this.onTap});
  final LiveRoomController c;
  final UserBrief host;
  final VoidCallback onTap;

  static const _nameMaxWidth = 96.0;

  @override
  Widget build(BuildContext context) {
    final room = c.detail!.room;
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Flexible(
          child: Semantics(
            button: true,
            label: 'Host ${host.displayName}. View profile',
            child: GestureDetector(
              onTap: onTap,
              behavior: HitTestBehavior.opaque,
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  SizedBox.square(
                    dimension: 44,
                    child: Center(child: BBAvatar.user(host, size: 38)),
                  ),
                  const SizedBox(width: 8),
                  Flexible(
                    child: ConstrainedBox(
                      constraints: const BoxConstraints(
                        maxWidth: _nameMaxWidth,
                      ),
                      child: ExcludeSemantics(
                        child: Column(
                          mainAxisSize: MainAxisSize.min,
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(
                              host.displayName,
                              maxLines: 1,
                              softWrap: false,
                              overflow: TextOverflow.ellipsis,
                              style: const TextStyle(
                                color: BBColors.ivory,
                                fontWeight: FontWeight.w700,
                                fontSize: 15,
                                height: 1.2,
                              ),
                            ),
                            const SizedBox(height: 2),
                            if (room.startedAt != null)
                              LiveElapsed(
                                since: room.startedAt!,
                                offset: c.detail!.clockOffset,
                                style: const TextStyle(
                                  color: BBColors.champagne,
                                  fontWeight: FontWeight.w600,
                                  fontSize: 13,
                                ),
                              ),
                          ],
                        ),
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
        if (!c.isHost) _FollowPill(uid: host.id),
      ],
    );
  }
}

/// The highest-ranked viewers (King, Crown, VVIP, VIP, then level, as the server sorts
/// them): each tier holder's pill sits above their avatar, which wears their badge. Scrolls
/// sideways and fades out at its right edge when there are more than fit.
class _TopViewers extends StatelessWidget {
  const _TopViewers({required this.viewers, required this.onTapUser});
  final List<UserBrief> viewers;
  final void Function(UserBrief user) onTapUser;

  static const _size = 30.0;
  static const _pill = 14.0;

  /// Tier first, then level; stable, so equal viewers keep the server's order.
  static List<UserBrief> ranked(List<UserBrief> viewers) {
    final indexed = viewers.indexed.toList()
      ..sort((a, b) {
        final byTier = b.$2.vipTier.compareTo(a.$2.vipTier);
        if (byTier != 0) return byTier;
        final byLevel = b.$2.level.compareTo(a.$2.level);
        return byLevel != 0 ? byLevel : a.$1.compareTo(b.$1);
      });
    return [for (final e in indexed) e.$2];
  }

  @override
  Widget build(BuildContext context) {
    if (viewers.isEmpty) return const SizedBox.shrink();
    return ShaderMask(
      shaderCallback: (r) => const LinearGradient(
        colors: [Colors.black, Colors.black, Colors.transparent],
        stops: [0, 0.85, 1],
      ).createShader(r),
      blendMode: BlendMode.dstIn,
      child: SingleChildScrollView(
        scrollDirection: Axis.horizontal,
        padding: const EdgeInsets.only(left: 6),
        child: Row(
          children: [
            for (final v in ranked(viewers))
              GestureDetector(
                onTap: () => onTapUser(v),
                child: Tooltip(
                  message: v.displayName,
                  // The tier pill above, then the avatar with its frame and badge.
                  child: SizedBox(
                    width: _size + 8,
                    height: _pill + 2 + _size,
                    child: Column(
                      children: [
                        SizedBox(
                          height: _pill,
                          child: v.vipTier > 0
                              ? FittedBox(
                                  fit: BoxFit.scaleDown,
                                  child: VipTag(v.vipTier),
                                )
                              : null,
                        ),
                        const SizedBox(height: 2),
                        BBAvatar.user(v, size: _size),
                      ],
                    ),
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }
}

/// The gold close button at the end of the header.
class _CloseButton extends StatelessWidget {
  const _CloseButton({required this.label, required this.onTap});
  final String label;
  final VoidCallback onTap;

  static const _disc = 36.0;

  @override
  Widget build(BuildContext context) => Tooltip(
    message: label,
    child: InkResponse(
      onTap: onTap,
      radius: _disc / 2 + 6,
      child: const SizedBox.square(
        dimension: 44,
        child: Center(
          child: DecoratedBox(
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              gradient: BBColors.goldGradient,
              boxShadow: [
                BoxShadow(
                  color: BBColors.goldShadow,
                  blurRadius: 6,
                  offset: Offset(0, 2),
                ),
              ],
            ),
            child: SizedBox.square(
              dimension: _disc,
              child: Icon(Icons.close_rounded, size: 22, color: BBColors.ink),
            ),
          ),
        ),
      ),
    ),
  );
}

/// "Follow" beside the host; hidden once following.
class _FollowPill extends ConsumerStatefulWidget {
  const _FollowPill({required this.uid});
  final String uid;
  @override
  ConsumerState<_FollowPill> createState() => _FollowPillState();
}

class _FollowPillState extends ConsumerState<_FollowPill> {
  bool _busy = false;

  Future<void> _follow() async {
    setState(() => _busy = true);
    try {
      await ref.read(accountRepo).follow(widget.uid, true);
      ref.invalidate(userProvider(widget.uid));
    } catch (e) {
      if (mounted) showError(context, e);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final following =
        ref.watch(userProvider(widget.uid)).value?.isFollowing ?? false;
    if (following) return const SizedBox.shrink();
    return Padding(
      padding: const EdgeInsets.only(left: 8),
      child: Semantics(
        button: true,
        enabled: !_busy,
        label: 'Follow host',
        excludeSemantics: true,
        child: Material(
          color: BBColors.heart,
          shape: const StadiumBorder(),
          clipBehavior: Clip.antiAlias,
          child: InkWell(
            onTap: _busy ? null : _follow,
            child: Padding(
              padding: const EdgeInsets.fromLTRB(8, 6, 11, 6),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  SizedBox.square(
                    dimension: 14,
                    child: _busy
                        ? const CircularProgressIndicator(
                            strokeWidth: 2,
                            color: BBColors.onAccent,
                          )
                        : const Icon(
                            Icons.add_rounded,
                            size: 14,
                            color: BBColors.onAccent,
                          ),
                  ),
                  const SizedBox(width: 3),
                  const Text(
                    'Follow',
                    style: TextStyle(
                      color: BBColors.onAccent,
                      fontSize: 12.5,
                      fontWeight: FontWeight.w700,
                      height: 1.1,
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// The full-width card under the header's first row: 💎 diamonds this live, viewers (tap
/// for the list), the lock state, and the host's ID at the end. Scales down rather than
/// overflow on a narrow phone.
class _StatsCard extends ConsumerWidget {
  const _StatsCard({required this.c, required this.onViewers});
  final LiveRoomController c;
  final VoidCallback onViewers;

  static const height = 36.0;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final room = c.detail!.room;
    // The host's wallet right now (seat 0's balance, pushed on every change to it).
    final wallet = c.hostDiamonds;
    final stars = starsFor(wallet, ref.watch(diamondsPerStarProvider));
    const figure = TextStyle(
      color: BBColors.ivory,
      fontSize: 15,
      fontWeight: FontWeight.w700,
      fontFeatures: [FontFeature.tabularFigures()],
    );
    Widget stat(Widget icon, String value, String label, [VoidCallback? tap]) =>
        Semantics(
          button: tap != null,
          label: '$label $value',
          excludeSemantics: true,
          child: GestureDetector(
            onTap: tap,
            behavior: HitTestBehavior.opaque,
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 6),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  icon,
                  const SizedBox(width: 5),
                  Text(value, style: figure),
                ],
              ),
            ),
          ),
        );
    return Container(
      height: height,
      padding: const EdgeInsets.symmetric(horizontal: 8),
      decoration: BoxDecoration(
        color: BBColors.scrim,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: BBColors.goldOutline),
      ),
      child: Row(
        children: [
          Expanded(
            child: Align(
              alignment: Alignment.centerLeft,
              child: FittedBox(
                fit: BoxFit.scaleDown,
                alignment: Alignment.centerLeft,
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    stat(
                      const Text('💎', style: TextStyle(fontSize: 15)),
                      Fmt.full(wallet),
                      'Host wallet, diamonds',
                    ),
                    stat(
                      const Icon(
                        Icons.star_rounded,
                        size: 19,
                        color: BBColors.gold,
                      ),
                      Fmt.full(stars),
                      'Host stars',
                    ),
                    stat(
                      const Icon(
                        Icons.remove_red_eye_rounded,
                        size: 18,
                        color: BBColors.champagne,
                      ),
                      Fmt.compact(c.viewerCount),
                      'Viewers',
                      onViewers,
                    ),
                    if (room.locked)
                      stat(
                        const Icon(
                          Icons.lock_rounded,
                          size: 16,
                          color: BBColors.goldLight,
                        ),
                        room.hasPassword ? 'Password' : 'Locked',
                        'Entry',
                      ),
                    // Only this platform moderator sees it: nobody else knows they're here.
                    if (c.stealth)
                      stat(
                        const Icon(
                          Icons.visibility_off_rounded,
                          size: 16,
                          color: BBColors.goldLight,
                        ),
                        'Hidden',
                        'You are hidden from the room',
                      ),
                  ],
                ),
              ),
            ),
          ),
          if (room.host.shortId.isNotEmpty)
            Text(
              'ID ${room.host.shortId}',
              style: const TextStyle(color: BBColors.champagne, fontSize: 11),
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

/// Round control of the live room: a scrim disc with a gold glyph, centred in a tap target
/// of at least [minWidth] × [rowExtent] (the rail stacks them at that pitch). [gold] fills
/// the disc with the gold gradient instead; [danger] turns the glyph red (mic off, leave).
class LiveRoundButton extends StatelessWidget {
  const LiveRoundButton({
    super.key,
    required this.icon,
    required this.onTap,
    required this.tooltip,
    this.gold = false,
    this.danger = false,
    this.badge = 0,
    this.toggled,
    this.size = disc,
  });
  final IconData icon;
  final VoidCallback? onTap;
  final String tooltip;
  final bool gold;
  final bool danger;
  final int badge;

  /// For on/off controls: announced as a toggle (true = the "off" state is showing).
  final bool? toggled;

  /// The disc's diameter.
  final double size;

  /// Default disc on the rail.
  static const disc = 34.0;

  /// Minimum tap target width (and the rail's column width).
  static const minWidth = 44.0;

  /// Minimum tap target height: the rail's pitch.
  static const rowExtent = 42.0;

  @override
  Widget build(BuildContext context) {
    Widget face = DecoratedBox(
      decoration: BoxDecoration(
        shape: BoxShape.circle,
        color: gold ? null : BBColors.scrim,
        gradient: gold ? BBColors.goldGradient : null,
      ),
      child: SizedBox.square(
        dimension: size,
        child: Icon(
          icon,
          size: size * 0.6,
          color: gold
              ? BBColors.ink
              : (danger ? BBColors.danger : BBColors.goldLight),
        ),
      ),
    );
    if (badge > 0) {
      face = Badge(
        backgroundColor: BBColors.danger,
        textColor: BBColors.ivory,
        label: Text(badge > 99 ? '99+' : '$badge'),
        child: face,
      );
    }
    return Semantics(
      button: true,
      toggled: toggled,
      child: Tooltip(
        message: tooltip,
        child: InkResponse(
          onTap: onTap,
          radius: size / 2 + 6,
          highlightShape: BoxShape.circle,
          child: SizedBox(
            width: size > minWidth ? size : minWidth,
            height: size > rowExtent ? size : rowExtent,
            child: Center(child: face),
          ),
        ),
      ),
    );
  }
}

/// The PK battle entry on the rail: a bold "PK" wordmark in a control's slot, no disc.
class _PkButton extends StatelessWidget {
  const _PkButton({required this.onTap});
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) => Semantics(
    button: true,
    label: 'PK battle',
    excludeSemantics: true,
    child: Tooltip(
      message: 'PK battle',
      child: InkResponse(
        onTap: onTap,
        radius: LiveRoundButton.disc / 2 + 6,
        child: const SizedBox(
          width: LiveRoundButton.minWidth,
          height: LiveRoundButton.rowExtent,
          child: Center(
            child: Text(
              'PK',
              style: TextStyle(
                color: BBColors.goldLight,
                fontSize: 18,
                fontWeight: FontWeight.w900,
                height: 1,
                shadows: [
                  Shadow(
                    color: BBColors.espressoShade,
                    offset: Offset(0, 1),
                    blurRadius: 3,
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    ),
  );
}

/// The right-hand column of controls, top to bottom: Games, PK, Share, Chat, Lock, Beauty &
/// filters, YouTube, More, and the chevron that folds the rest away. Each
/// shows by role: the host gets most of them, a viewer Games, Share, Chat and More. Mic,
/// camera, flip and the seat queue (the phone) are in the [LiveBottomBar]. It scrolls,
/// anchored at the bottom, on a
/// short screen.
class LiveSideRail extends ConsumerStatefulWidget {
  const LiveSideRail({
    super.key,
    required this.c,
    required this.onPk,
    required this.onLock,
    required this.onShare,
    required this.onGames,
    required this.onFilters,
    required this.onMore,
    this.onYouTube,
  });
  final LiveRoomController c;
  final VoidCallback onPk;
  final VoidCallback onLock;

  /// Gets the button's context, so the iPad share sheet can anchor to it.
  final void Function(BuildContext anchor) onShare;
  final VoidCallback onGames;

  /// Opens the beauty & filter sheet for my camera.
  final VoidCallback onFilters;
  final VoidCallback onMore;

  /// Opens the YouTube music sheet; null hides the button.
  final VoidCallback? onYouTube;

  @override
  ConsumerState<LiveSideRail> createState() => _LiveSideRailState();
}

class _LiveSideRailState extends ConsumerState<LiveSideRail> {
  bool _expanded = true;

  @override
  Widget build(BuildContext context) {
    final c = widget.c;
    final config = ref.watch(appConfigProvider).value;
    final canPk =
        c.isHost &&
        c.isVideoRoom &&
        (config?.feature('pkEnabled') ?? true) &&
        c.pk == null &&
        c.pkOutgoing == null;
    final staged = c.isHost || c.onSeat;
    final camTools = staged && c.isVideoRoom;
    // Still shown while a song plays with the feature switched off, so it can be stopped.
    final canYouTube =
        widget.onYouTube != null &&
        c.canControlYouTube &&
        ((config?.feature('youtubeEnabled') ?? false) ||
            c.youtube?.current != null);
    final controls = <Widget>[
      // `gamesInLive` is off when games or live-room games are switched off.
      if ((config?.feature('gamesEnabled') ?? true) &&
          (config?.feature('gamesInLive') ?? true))
        LiveRoundButton(
          icon: Icons.sports_esports_rounded,
          tooltip: 'Games',
          onTap: widget.onGames,
        ),
      if (canPk) _PkButton(onTap: widget.onPk),
      Builder(
        builder: (anchor) => LiveRoundButton(
          icon: Icons.share_rounded,
          tooltip: 'Share',
          onTap: () => widget.onShare(anchor),
        ),
      ),
      LiveRoundButton(
        icon: c.chatVisible
            ? Icons.chat_bubble_outline_rounded
            : Icons.comments_disabled_outlined,
        tooltip: c.chatVisible ? 'Hide chat' : 'Show chat',
        toggled: !c.chatVisible,
        onTap: c.toggleChat,
      ),
      if (c.isHost)
        LiveRoundButton(
          icon: c.locked ? Icons.lock_rounded : Icons.lock_open_rounded,
          tooltip: c.locked ? 'Unlock live' : 'Lock live',
          toggled: c.locked,
          onTap: widget.onLock,
        ),
      // Mic, camera and flip live in the bottom bar (`LiveBottomBar`).
      if (camTools) ...[
        // Works with the camera off too: the look applies when it comes back on.
        if (CameraFilterChannel.isSupported)
          LiveRoundButton(
            icon: Icons.auto_awesome_rounded,
            tooltip: 'Beauty & filters',
            onTap: widget.onFilters,
          ),
      ],
      if (canYouTube)
        LiveRoundButton(
          icon: Icons.smart_display_rounded,
          tooltip: 'YouTube music',
          badge: c.youtube?.count ?? 0,
          onTap: widget.onYouTube,
        ),
      LiveRoundButton(
        icon: Icons.more_horiz_rounded,
        tooltip: 'More',
        onTap: widget.onMore,
      ),
    ];
    return Padding(
      padding: const EdgeInsets.only(right: 4),
      child: SingleChildScrollView(
        reverse: true,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            ClipRect(
              child: AnimatedSize(
                duration: const Duration(milliseconds: 220),
                curve: Curves.easeOutCubic,
                alignment: Alignment.bottomCenter,
                child: _expanded
                    ? Column(mainAxisSize: MainAxisSize.min, children: controls)
                    : const SizedBox(width: LiveRoundButton.minWidth),
              ),
            ),
            LiveRoundButton(
              icon: _expanded
                  ? Icons.keyboard_arrow_down_rounded
                  : Icons.keyboard_arrow_up_rounded,
              tooltip: _expanded ? 'Hide controls' : 'Show controls',
              toggled: !_expanded,
              onTap: () => setState(() => _expanded = !_expanded),
            ),
          ],
        ),
      ),
    );
  }
}

/// The bottom row: the chat field, then (for the host and guests on stage) Mic, Camera and
/// Flip, then Gift, the stage phone and the heart. The phone depends on the role: the host,
/// room admins and platform moderators open the viewers / waiting / stage / admins sheet
/// (with the queue's count as a badge), a viewer asks for a seat (or cancels the request),
/// a guest on stage leaves it.
///
/// With the media controls the row gets tight on a phone: their discs shrink to
/// [stagedButton], the chat field becomes a round chat button when it would be narrower than
/// [minFieldWidth], and on the narrowest screens the heart goes (double-tapping the stage
/// still sends hearts).
class LiveBottomBar extends StatelessWidget {
  const LiveBottomBar({
    super.key,
    required this.c,
    required this.onCompose,
    required this.onGift,
    required this.onParticipants,
    required this.onStageAction,
    required this.onHeart,
  });
  final LiveRoomController c;
  final VoidCallback onCompose;
  final VoidCallback onGift;

  /// The phone of the host, room admins and platform moderators
  /// ([LiveRoomController.canManageStage]): viewers, the seat queue, the stage and the
  /// admins, opened on the queue. Their own seat action is in that sheet.
  final VoidCallback onParticipants;

  /// A viewer's or guest's phone: ask for a seat, cancel the request, or leave.
  final VoidCallback onStageAction;
  final VoidCallback onHeart;

  /// The gift, phone and heart discs for viewers.
  static const button = 48.0;

  /// Every disc while the media controls are in the row.
  static const stagedButton = 40.0;

  /// The narrowest the "Say something…" field may get before it turns into a button.
  static const minFieldWidth = 110.0;
  static const _gap = 6.0;
  static const _padding = EdgeInsets.fromLTRB(12, 4, 8, 10);

  /// The row with its padding.
  static const height = button + 14;

  Widget _phone(double size) {
    if (c.canManageStage) {
      return LiveRoundButton(
        icon: Icons.phone_in_talk_rounded,
        tooltip: 'Guests & requests',
        badge: c.seatRequests.length,
        size: size,
        onTap: onParticipants,
      );
    }
    if (c.onSeat) {
      return LiveRoundButton(
        icon: Icons.call_end_rounded,
        tooltip: 'Leave the stage',
        danger: true,
        size: size,
        onTap: onStageAction,
      );
    }
    if (c.canSelfStage) {
      return LiveRoundButton(
        icon: Icons.add_call,
        tooltip: 'Go on stage',
        size: size,
        onTap: onStageAction,
      );
    }
    return LiveRoundButton(
      icon: c.seatRequestPending
          ? Icons.phone_in_talk_rounded
          : Icons.call_rounded,
      tooltip: c.seatRequestPending
          ? 'Cancel request'
          : 'Ask to join the stage',
      toggled: c.seatRequestPending,
      size: size,
      onTap: onStageAction,
    );
  }

  /// My mic, and in video rooms my camera and the flip, while I'm on stage.
  List<Widget> _media(BuildContext context, double size) => [
    LiveRoundButton(
      icon: c.micOn ? Icons.mic_rounded : Icons.mic_off_rounded,
      tooltip: c.micOn ? 'Mute' : 'Unmute',
      danger: !c.micOn,
      toggled: !c.micOn,
      size: size,
      onTap: c.toggleMic,
    ),
    if (c.isVideoRoom) ...[
      LiveRoundButton(
        icon: c.cameraOn ? Icons.videocam_rounded : Icons.videocam_off_rounded,
        tooltip: c.cameraOn ? 'Camera off' : 'Camera on',
        danger: !c.cameraOn,
        toggled: !c.cameraOn,
        size: size,
        onTap: c.toggleCamera,
      ),
      LiveRoundButton(
        icon: Icons.cameraswitch_rounded,
        tooltip: 'Flip camera',
        size: size,
        // There's nothing to flip while the camera is off.
        onTap: c.cameraOn
            ? c.flipCamera
            : () => showMessage(context, 'Turn your camera on to flip it'),
      ),
    ],
  ];

  @override
  Widget build(BuildContext context) => Padding(
    padding: _padding,
    child: LayoutBuilder(
      builder: (context, box) {
        final staged = c.isHost || c.onSeat;
        final size = staged ? stagedButton : button;
        final slot = math.max(size, LiveRoundButton.minWidth) + _gap;
        final media = staged ? _media(context, size) : const <Widget>[];
        final heart = LiveRoundButton(
          icon: Icons.favorite_rounded,
          tooltip: 'Send hearts',
          size: size,
          onTap: onHeart,
        );
        final trailing = [
          ...media,
          LiveRoundButton(
            icon: Icons.card_giftcard_rounded,
            tooltip: 'Send a gift',
            gold: true,
            size: size,
            onTap: onGift,
          ),
          _phone(size),
          heart,
        ];
        final width = box.maxWidth;
        final Widget chat;
        if (width - trailing.length * slot >= minFieldWidth) {
          chat = Expanded(child: _ChatField(onTap: onCompose));
        } else {
          chat = LiveRoundButton(
            icon: Icons.chat_bubble_outline_rounded,
            tooltip: 'Write a message',
            size: size,
            onTap: onCompose,
          );
          // Still too wide: the heart goes (double-tap the stage instead).
          if ((trailing.length + 1) * slot - _gap > width) {
            trailing.remove(heart);
          }
        }
        return Row(
          mainAxisAlignment: MainAxisAlignment.end,
          children: [
            chat,
            for (final b in trailing) ...[const SizedBox(width: _gap), b],
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
        height: 44,
        padding: const EdgeInsets.symmetric(horizontal: 16),
        decoration: BoxDecoration(
          color: BBColors.scrim,
          borderRadius: BorderRadius.circular(22),
          border: Border.all(color: BBColors.champagneVeil),
        ),
        child: const Align(
          alignment: Alignment.centerLeft,
          child: Text(
            'Say something…',
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: TextStyle(color: BBColors.champagne, fontSize: 14),
          ),
        ),
      ),
    ),
  );
}
