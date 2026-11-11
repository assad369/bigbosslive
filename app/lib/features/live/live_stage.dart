import 'package:cached_network_image/cached_network_image.dart';
import 'package:flutter/material.dart';
import 'package:livekit_client/livekit_client.dart';

import '../../core/theme/bb_colors.dart';
import '../../core/utils/format.dart';
import '../../core/widgets/widgets.dart';
import '../../models/models.dart';
import 'live_room_controller.dart';
import 'pk_widgets.dart';
import 'speaking_indicator.dart';

/// Space the stage leaves for the top bar and info row.
const stageTopInset = 104.0;

/// The room's media: full-screen host, the multi-guest grid, the PK arena, or the audio
/// seat grid. Tapping a person calls [onTapUser]; tapping an empty audio seat calls
/// [onTapEmptySeat].
class LiveStage extends StatelessWidget {
  const LiveStage({
    super.key,
    required this.c,
    required this.onTapUser,
    required this.onTapEmptySeat,
    this.onSwap,
    this.onRemoveFromStage,
  });
  final LiveRoomController c;
  final void Function(UserBrief user) onTapUser;
  final void Function(Seat seat) onTapEmptySeat;

  /// Moves a guest into the host spot (or restores it, with null) on long-press. Null for
  /// people who can't swap.
  final void Function(String? uid)? onSwap;

  /// Takes a guest off the stage from the ✕ on their tile. Shown only where
  /// [LiveRoomController.canRemoveFromStage] allows it.
  final void Function(Seat seat)? onRemoveFromStage;

  VoidCallback? _swap(Seat seat) {
    final swap = onSwap;
    final action = swap == null ? null : c.swapActionFor(seat);
    return action == null ? null : () => swap!(action.uid);
  }

  VoidCallback? _remove(Seat seat) {
    final remove = onRemoveFromStage;
    return remove == null || !c.canRemoveFromStage(seat)
        ? null
        : () => remove(seat);
  }

  @override
  Widget build(BuildContext context) {
    final d = c.detail!;
    final background = d.backgroundUrl ?? d.room.coverUrl;
    final backdrop = background == null
        ? const ColoredBox(color: BBColors.espresso)
        : CachedNetworkImage(
            imageUrl: background,
            fit: BoxFit.cover,
            color: BBColors.espressoShade,
            colorBlendMode: BlendMode.darken,
          );
    final top = MediaQuery.paddingOf(context).top + stageTopInset;

    if (d.room.isAudio) {
      return Stack(
        fit: StackFit.expand,
        children: [
          backdrop,
          Positioned(
            top: top,
            left: 0,
            right: 0,
            child: SeatGrid(
              c: c,
              onTapUser: onTapUser,
              onTapEmpty: onTapEmptySeat,
              onLongPress: _swap,
            ),
          ),
        ],
      );
    }

    final pk = c.pk;
    if (pk != null) {
      final guests = c.stage.where((s) => s.index > 0).toList();
      return Stack(
        fit: StackFit.expand,
        children: [
          backdrop,
          Positioned(
            top: top,
            left: 0,
            right: 0,
            child: Column(
              children: [
                PkArena(c: c, battle: pk),
                if (guests.isNotEmpty)
                  SizedBox(
                    height: 92,
                    child: ListView(
                      scrollDirection: Axis.horizontal,
                      padding: const EdgeInsets.fromLTRB(8, 6, 8, 0),
                      children: [
                        for (final s in guests)
                          Padding(
                            padding: const EdgeInsets.only(right: 6),
                            child: SizedBox(
                              width: 68,
                              child: StageTile(
                                c: c,
                                seat: s,
                                compact: true,
                                onTap: () => onTapUser(s.user!),
                                onRemove: _remove(s),
                              ),
                            ),
                          ),
                      ],
                    ),
                  ),
              ],
            ),
          ),
        ],
      );
    }

    final stage = c.stage;
    if (stage.length <= 1) {
      // Solo: the host's camera is the whole screen.
      final host = stage.firstOrNull;
      return Stack(
        fit: StackFit.expand,
        children: [
          backdrop,
          if (host != null)
            StageTile(
              c: c,
              seat: host,
              fullScreen: true,
              onTap: () => onTapUser(host.user!),
            ),
        ],
      );
    }
    final height = MediaQuery.sizeOf(context).height;
    final fraction = switch (stage.length) {
      2 => 0.40,
      <= 4 => 0.55,
      _ => 0.60,
    };
    return Stack(
      fit: StackFit.expand,
      children: [
        backdrop,
        Positioned(
          top: top,
          left: 0,
          right: 0,
          height: height * fraction,
          child: ParticipantGrid(
            tiles: [
              for (final s in stage)
                StageTile(
                  // Keyed by person, so a swap moves their video instead of rebuilding it.
                  key: ValueKey(s.user!.id),
                  c: c,
                  seat: s,
                  onTap: () => onTapUser(s.user!),
                  onLongPress: _swap(s),
                  onRemove: _remove(s),
                ),
            ],
          ),
        ),
      ],
    );
  }
}

/// Arranges 2–13 stage tiles, host first:
/// 2 side by side · 3–4 in a 2×2 grid · 5–9 a large host tile with two beside it, then rows
/// of three · 10–13 the host beside a 2×2 block, then two rows of four.
class ParticipantGrid extends StatelessWidget {
  const ParticipantGrid({super.key, required this.tiles});
  final List<Widget> tiles;

  static const _gap = 2.0;

  Widget _cell(int i) => i < tiles.length ? tiles[i] : const SizedBox.shrink();

  Widget _row(List<int> indexes) => Row(
    crossAxisAlignment: CrossAxisAlignment.stretch,
    children: [
      for (var k = 0; k < indexes.length; k++) ...[
        if (k > 0) const SizedBox(width: _gap),
        Expanded(child: _cell(indexes[k])),
      ],
    ],
  );

  Widget _column(List<Widget> rows, List<int> flex) => Column(
    crossAxisAlignment: CrossAxisAlignment.stretch,
    children: [
      for (var k = 0; k < rows.length; k++) ...[
        if (k > 0) const SizedBox(height: _gap),
        Expanded(flex: flex[k], child: rows[k]),
      ],
    ],
  );

  @override
  Widget build(BuildContext context) {
    final n = tiles.length;
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 4),
      child: switch (n) {
        <= 2 => _row([0, 1]),
        <= 4 => _column(
          [
            _row([0, 1]),
            _row([2, 3]),
          ],
          [1, 1],
        ),
        <= 9 => _column(
          [
            Row(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Expanded(flex: 2, child: _cell(0)),
                const SizedBox(width: _gap),
                Expanded(child: _column([_cell(1), _cell(2)], [1, 1])),
              ],
            ),
            _row([3, 4, 5]),
            if (n > 6) _row([6, 7, 8]),
          ],
          [4, 2, if (n > 6) 2],
        ),
        _ => _column(
          [
            Row(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Expanded(child: _cell(0)),
                const SizedBox(width: _gap),
                Expanded(
                  child: _column(
                    [
                      _row([1, 2]),
                      _row([3, 4]),
                    ],
                    [1, 1],
                  ),
                ),
              ],
            ),
            _row([5, 6, 7, 8]),
            _row([9, 10, 11, 12]),
          ],
          [2, 1, 1],
        ),
      },
    );
  }
}

/// One person on stage: their video (or avatar when the camera is off), a speaking ring,
/// mute/camera-off markers, a guest's spot number, a ✕ for those who may take them off the
/// stage, and a [StageNamePlate] (avatar, name and diamond balance). The balance follows
/// the room's `balances` events.
class StageTile extends StatelessWidget {
  const StageTile({
    super.key,
    required this.c,
    required this.seat,
    required this.onTap,
    this.onLongPress,
    this.onRemove,
    this.fullScreen = false,
    this.compact = false,
  });
  final LiveRoomController c;
  final Seat seat;
  final VoidCallback onTap;

  /// Swaps this person with the host spot (host, room admins and staff only).
  final VoidCallback? onLongPress;

  /// Takes this guest off the stage (host, room admins and `live.moderate` staff); the ✕
  /// shows only when set.
  final VoidCallback? onRemove;
  final bool fullScreen;
  final bool compact;

  @override
  Widget build(BuildContext context) {
    final user = seat.user!;
    final track = c.videoOf(user.id);
    final micOff =
        seat.muted || (c.isConnected(user.id) && !c.isMicOn(user.id));
    final mirror = user.id == c.myUid && c.frontCamera;
    final role = c.roleOf(user.id);
    final spot = seat.index > 0 ? c.spotOf(user.id) : null;
    final remove = onRemove;

    final media = track == null
        ? _AvatarFallback(c: c, user: user, compact: compact || !fullScreen)
        : VideoTrackRenderer(
            track,
            fit: VideoViewFit.cover,
            mirrorMode: mirror
                ? VideoViewMirrorMode.mirror
                : VideoViewMirrorMode.off,
          );
    // Solo host: the host pill opens their card; the screen itself is for double-tap hearts.
    if (fullScreen) return media;
    return GestureDetector(
      onTap: onTap,
      onLongPress: onLongPress,
      // Only the speaking border follows the (frequent) speaker updates; the video and
      // overlays are built once and passed through.
      child: ListenableBuilder(
        listenable: c.speakers,
        builder: (context, child) {
          final speaking = c.isSpeaking(user.id);
          return AnimatedContainer(
            duration: const Duration(milliseconds: 180),
            decoration: BoxDecoration(
              color: BBColors.espresso,
              borderRadius: BorderRadius.circular(compact ? 10 : 6),
              border: Border.all(
                color: speaking ? BBColors.goldLight : BBColors.champagneTint,
                width: speaking ? 2.5 : 1,
              ),
            ),
            clipBehavior: Clip.antiAlias,
            child: child,
          );
        },
        child: Stack(
          fit: StackFit.expand,
          children: [
            media,
            if (remove != null || c.isSwapped(user.id))
              Positioned(
                left: 2,
                top: 2,
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    if (remove != null)
                      StageCloseButton(
                        name: user.displayName,
                        compact: compact,
                        onPressed: remove,
                      ),
                    if (c.isSwapped(user.id))
                      const Padding(
                        padding: EdgeInsets.all(2),
                        child: SwapMarker(),
                      ),
                  ],
                ),
              ),
            Positioned(
              right: 4,
              top: 4,
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  if (spot != null) SpotBadge(spot, compact: compact),
                  if (micOff)
                    const _StatusDot(Icons.mic_off_rounded)
                  else
                    ListenableBuilder(
                      listenable: c.speakers,
                      builder: (_, _) => SpeakingBars(
                        active: c.isSpeaking(user.id),
                        size: compact ? 10 : 12,
                      ),
                    ),
                  if (seat.videoMuted)
                    const _StatusDot(Icons.videocam_off_rounded),
                ],
              ),
            ),
            Positioned(
              left: 4,
              right: 4,
              bottom: 4,
              child: StageNamePlate(
                user: user,
                diamonds: seat.diamonds,
                isHost: role == RoomRole.host,
                compact: compact,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _AvatarFallback extends StatelessWidget {
  const _AvatarFallback({
    required this.c,
    required this.user,
    required this.compact,
  });
  final LiveRoomController c;
  final UserBrief user;
  final bool compact;

  @override
  Widget build(BuildContext context) => ColoredBox(
    color: BBColors.espresso,
    child: Center(
      child: LayoutBuilder(
        builder: (_, box) => ListenableBuilder(
          listenable: c.speakers,
          child: BBAvatar.user(
            user,
            size: compact ? (box.biggest.shortestSide * 0.5).clamp(28, 72) : 96,
          ),
          // Camera off: the avatar itself pulses while they talk.
          builder: (_, avatar) =>
              SpeakingGlow(active: c.isSpeaking(user.id), child: avatar!),
        ),
      ),
    ),
  );
}

/// A guest's place on the stage (1 = first to sit down), at the top of their tile.
class SpotBadge extends StatelessWidget {
  const SpotBadge(this.spot, {super.key, this.compact = false});
  final int spot;
  final bool compact;

  @override
  Widget build(BuildContext context) {
    final size = compact ? 16.0 : 18.0;
    return Semantics(
      label: 'Spot $spot',
      excludeSemantics: true,
      child: Container(
        constraints: BoxConstraints(minWidth: size),
        height: size,
        margin: const EdgeInsets.only(right: 3),
        padding: const EdgeInsets.symmetric(horizontal: 4),
        alignment: Alignment.center,
        decoration: BoxDecoration(
          color: BBColors.scrim,
          borderRadius: BorderRadius.circular(size / 2),
          border: Border.all(color: BBColors.goldOutline),
        ),
        child: Text(
          '$spot',
          style: TextStyle(
            color: BBColors.goldLight,
            fontSize: compact ? 9 : 10,
            fontWeight: FontWeight.w800,
            height: 1,
            fontFeatures: const [FontFeature.tabularFigures()],
          ),
        ),
      ),
    );
  }
}

/// The ✕ in a guest tile's top-left corner that takes them off the stage. The visible
/// circle is small; the tap target is 32 px (28 on compact tiles).
class StageCloseButton extends StatelessWidget {
  const StageCloseButton({
    super.key,
    required this.name,
    required this.onPressed,
    this.compact = false,
  });
  final String name;
  final VoidCallback onPressed;
  final bool compact;

  @override
  Widget build(BuildContext context) {
    final circle = compact ? 16.0 : 20.0;
    // Its own node: inside the tile's tap target it would otherwise merge into the tile.
    return Semantics(
      container: true,
      button: true,
      label: 'Remove $name from stage',
      excludeSemantics: true,
      child: GestureDetector(
        onTap: onPressed,
        behavior: HitTestBehavior.opaque,
        child: SizedBox.square(
          dimension: compact ? 28 : 32,
          child: Align(
            alignment: Alignment.topLeft,
            child: Container(
              width: circle,
              height: circle,
              margin: const EdgeInsets.all(2),
              decoration: BoxDecoration(
                color: BBColors.scrim,
                shape: BoxShape.circle,
                border: Border.all(color: BBColors.champagneTint),
              ),
              child: Icon(
                Icons.close_rounded,
                size: circle * 0.7,
                color: BBColors.ivory,
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// On the two tiles of a host-spot swap: the guest now in the host's spot, and the host.
class SwapMarker extends StatelessWidget {
  const SwapMarker({super.key, this.size = 18});
  final double size;

  @override
  Widget build(BuildContext context) => Semantics(
    label: 'Swapped with the host spot',
    child: Container(
      width: size,
      height: size,
      decoration: const BoxDecoration(
        gradient: BBColors.goldGradient,
        shape: BoxShape.circle,
      ),
      child: Icon(
        Icons.swap_horiz_rounded,
        size: size * 0.7,
        color: BBColors.ink,
      ),
    ),
  );
}

/// The plate along the bottom of a stage tile: the person's avatar on the left, beside
/// two lines: name, then their diamond balance. (The level lives in their profile sheet,
/// leaving the name the room to read on a small tile.)
///
/// Public so it can be tested without a [LiveRoomController].
class StageNamePlate extends StatelessWidget {
  const StageNamePlate({
    super.key,
    required this.user,
    required this.diamonds,
    required this.isHost,
    required this.compact,
  });
  final UserBrief user;
  final int diamonds;

  /// Gives the avatar a gold ring, so the host stands out without a role badge.
  final bool isHost;
  final bool compact;

  @override
  Widget build(BuildContext context) => Container(
    padding: EdgeInsets.symmetric(horizontal: compact ? 2 : 3, vertical: 2),
    decoration: BoxDecoration(
      color: BBColors.scrim,
      borderRadius: BorderRadius.circular(6),
    ),
    child: Row(
      children: [
        // Frames are left off at this size: they would cover the name. The tier badge
        // shows only from 28 up (`AvatarBadgeSlot.minAvatarSize`).
        BBAvatar(
          url: user.avatarUrl,
          name: user.displayName,
          badge: user.badge,
          ring: isHost,
          size: compact ? 20 : 28,
        ),
        SizedBox(width: compact ? 3 : 4),
        Expanded(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                user.displayName,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(
                  color: BBColors.ivory,
                  fontSize: compact ? 9 : 11,
                  fontWeight: FontWeight.w600,
                ),
              ),
              const SizedBox(height: 1),
              DiamondChip(diamonds, compact: compact, plain: true),
            ],
          ),
        ),
      ],
    ),
  );
}

/// "💎 12,345" under a stage tile's name or an audio seat. [plain] drops the chip's own
/// background, for use on a surface that already has one.
class DiamondChip extends StatelessWidget {
  const DiamondChip(
    this.diamonds, {
    super.key,
    this.compact = false,
    this.plain = false,
  });
  final int diamonds;
  final bool compact;
  final bool plain;

  @override
  Widget build(BuildContext context) {
    final content = Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Text('💎', style: TextStyle(fontSize: compact ? 8 : 10)),
        const SizedBox(width: 2),
        // The full number, shrunk to fit a narrow seat rather than cut off.
        Flexible(
          child: FittedBox(
            fit: BoxFit.scaleDown,
            child: Text(
              Fmt.full(diamonds),
              maxLines: 1,
              style: TextStyle(
                color: BBColors.goldLight,
                fontSize: compact ? 9 : 11,
                fontWeight: FontWeight.w700,
                fontFeatures: const [FontFeature.tabularFigures()],
              ),
            ),
          ),
        ),
      ],
    );
    return Semantics(
      label: '${Fmt.full(diamonds)} diamonds',
      excludeSemantics: true,
      child: plain
          ? content
          : Container(
              padding: EdgeInsets.symmetric(
                horizontal: compact ? 4 : 6,
                vertical: 1,
              ),
              decoration: BoxDecoration(
                color: BBColors.scrim,
                borderRadius: BorderRadius.circular(8),
                border: Border.all(color: BBColors.goldOutline, width: 0.5),
              ),
              child: content,
            ),
    );
  }
}

class _StatusDot extends StatelessWidget {
  const _StatusDot(this.icon);
  final IconData icon;
  @override
  Widget build(BuildContext context) => Container(
    margin: const EdgeInsets.only(left: 3),
    padding: const EdgeInsets.all(3),
    decoration: const BoxDecoration(
      color: BBColors.danger,
      shape: BoxShape.circle,
    ),
    child: Icon(icon, size: 11, color: BBColors.ivory),
  );
}

/// "Host" / "Admin" tag next to a name. Guests and viewers get nothing.
class RoleBadge extends StatelessWidget {
  const RoleBadge(this.role, {super.key, this.dense = false});
  final RoomRole? role;
  final bool dense;

  @override
  Widget build(BuildContext context) {
    final (label, icon) = switch (role) {
      RoomRole.host => ('Host', Icons.star_rounded),
      RoomRole.admin => ('Admin', Icons.shield_rounded),
      _ => ('', null),
    };
    if (icon == null) return const SizedBox.shrink();
    return Container(
      padding: EdgeInsets.symmetric(horizontal: dense ? 3 : 5, vertical: 1),
      decoration: BoxDecoration(
        gradient: role == RoomRole.host ? BBColors.goldGradient : null,
        color: role == RoomRole.admin ? BBColors.info : null,
        borderRadius: BorderRadius.circular(6),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(
            icon,
            size: dense ? 9 : 11,
            color: role == RoomRole.host ? BBColors.ink : BBColors.ivory,
          ),
          const SizedBox(width: 2),
          Text(
            label,
            style: TextStyle(
              color: role == RoomRole.host ? BBColors.ink : BBColors.ivory,
              fontSize: dense ? 8 : 10,
              fontWeight: FontWeight.w800,
            ),
          ),
        ],
      ),
    );
  }
}

/// Audio ("Party") room seats, four to a row. Taps open the person or, on an empty seat,
/// the take-a-seat / seat-management flow.
class SeatGrid extends StatelessWidget {
  const SeatGrid({
    super.key,
    required this.c,
    required this.onTapUser,
    required this.onTapEmpty,
    this.onLongPress,
  });
  final LiveRoomController c;
  final void Function(UserBrief user) onTapUser;
  final void Function(Seat seat) onTapEmpty;

  /// The long-press action for a seat (the host-spot swap), or null for none.
  final VoidCallback? Function(Seat seat)? onLongPress;

  @override
  Widget build(BuildContext context) {
    final seats = c.displaySeats;
    return GridView.count(
      crossAxisCount: 4,
      padding: const EdgeInsets.symmetric(horizontal: 16),
      shrinkWrap: true,
      physics: const NeverScrollableScrollPhysics(),
      childAspectRatio: 0.7,
      children: [
        for (final s in seats)
          InkWell(
            borderRadius: BorderRadius.circular(12),
            onTap: () => s.user != null ? onTapUser(s.user!) : onTapEmpty(s),
            onLongPress: s.user == null ? null : onLongPress?.call(s),
            child: Column(
              children: [
                Stack(
                  clipBehavior: Clip.none,
                  children: [
                    ListenableBuilder(
                      listenable: c.speakers,
                      builder: (context, child) => AnimatedContainer(
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
                        child: child,
                      ),
                      child: s.user != null
                          ? BBAvatar.user(s.user, size: 58, ring: s.index == 0)
                          : Container(
                              width: 58,
                              height: 58,
                              decoration: BoxDecoration(
                                shape: BoxShape.circle,
                                color: BBColors.champagneTint,
                                border: Border.all(color: BBColors.goldOutline),
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
                    if (s.user != null && c.isSwapped(s.user!.id))
                      const Positioned(
                        right: 0,
                        top: 0,
                        child: SwapMarker(size: 16),
                      ),
                  ],
                ),
                const SizedBox(height: 4),
                Row(
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [
                    if (s.user != null && s.muted)
                      const Padding(
                        padding: EdgeInsets.only(right: 2),
                        child: Icon(
                          Icons.mic_off,
                          size: 12,
                          color: BBColors.danger,
                        ),
                      ),
                    Flexible(
                      child: Text(
                        s.user?.displayName ??
                            (s.index == 0 ? 'Host' : 'Seat ${s.index}'),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(
                          color: BBColors.ivory,
                          fontSize: 11,
                        ),
                      ),
                    ),
                  ],
                ),
                if (s.user != null) ...[
                  Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      RoleBadge(c.roleOf(s.user!.id), dense: true),
                      const SizedBox(width: 2),
                      LevelBadge(s.user!.level, dense: true),
                      if (s.user!.vipTier > 0) ...[
                        const SizedBox(width: 2),
                        VipTag(s.user!.vipTier),
                      ],
                    ],
                  ),
                  const SizedBox(height: 2),
                  DiamondChip(s.diamonds, compact: true),
                ],
              ],
            ),
          ),
      ],
    );
  }
}
