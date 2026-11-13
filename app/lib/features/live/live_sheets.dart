import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/providers.dart';
import '../../core/theme/bb_colors.dart';
import '../../core/widgets/wallet_balance.dart';
import '../../core/widgets/widgets.dart';
import '../../models/models.dart';
import '../moderation/ban_sheet.dart';
import '../profile/profile_screens.dart';
import 'live_room_controller.dart';
import 'live_stage.dart';

Future<bool> _confirm(
  BuildContext context,
  String title, {
  String? message,
  required String action,
}) async =>
    await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text(title),
        content: message == null ? null : Text(message),
        actions: [
          TextButton(
            onPressed: () => ctx.pop(false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            style: FilledButton.styleFrom(backgroundColor: BBColors.danger),
            onPressed: () => ctx.pop(true),
            child: Text(action),
          ),
        ],
      ),
    ) ??
    false;

/// Runs [action], reporting failures and closing the sheet on success.
Future<void> _run(
  BuildContext context,
  Future<void> Function() action, {
  String? done,
}) async {
  try {
    await action();
    if (!context.mounted) return;
    if (done != null) showMessage(context, done);
    if (context.canPop()) context.pop();
  } catch (e) {
    if (context.mounted) showError(context, e);
  }
}

/// A person in the room: profile, follow, gift, report, and — for the host and room
/// admins — stage and moderation actions that match the person's role.
class LiveUserSheet extends ConsumerWidget {
  const LiveUserSheet({
    super.key,
    required this.c,
    required this.user,
    required this.onGift,
  });
  final LiveRoomController c;
  final UserBrief user;
  final void Function(UserBrief user) onGift;

  static Future<void> show(
    BuildContext context,
    LiveRoomController c,
    UserBrief user, {
    required void Function(UserBrief user) onGift,
  }) => showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    builder: (_) => LiveUserSheet(c: c, user: user, onGift: onGift),
  );

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final me = user.id == c.myUid;
    final role = c.roleOf(user.id);
    final myRole = c.roleOf(c.myUid);
    final seat = c.detail?.seats
        .where((s) => s.index > 0 && s.user?.id == user.id)
        .firstOrNull;
    // Admins can't act on the host or on each other; the server enforces the same.
    // Platform moderators and `live.moderate` staff manage anyone but the host, like on the
    // tile's ✕; the server refuses them for staff and other platform moderators.
    final canModerate =
        !me &&
        role != RoomRole.host &&
        (myRole == RoomRole.host ||
            c.isLiveModerator ||
            (myRole == RoomRole.admin && role != RoomRole.admin));
    final profile = ref.watch(userProvider(user.id));
    final following = profile.value?.isFollowing ?? false;
    final myDiamonds = me ? ref.watch(meProvider).wallet.diamonds : null;
    final stageSeat = c.detail?.seats
        .where((s) => s.user?.id == user.id)
        .firstOrNull;
    final swap = stageSeat == null ? null : c.swapActionFor(stageSeat);

    final actions = <Widget>[
      if (swap != null)
        ListTile(
          leading: const Icon(Icons.swap_horiz_rounded),
          title: Text(
            swap.uid == null ? 'Restore host spot' : 'Move to host spot',
          ),
          subtitle: swap.uid == null
              ? null
              : const Text('Shows them in the host’s place on the stage'),
          onTap: () => _run(context, () => c.swapStage(swap.uid)),
        ),
      if (canModerate && seat != null) ...[
        ListTile(
          leading: Icon(seat.muted ? Icons.mic_rounded : Icons.mic_off_rounded),
          title: Text(seat.muted ? 'Allow mic' : 'Mute mic'),
          onTap: () => _run(
            context,
            () => c.manageSeat(seat.index, seat.muted ? 'unmute' : 'mute'),
          ),
        ),
        if (c.isVideoRoom)
          ListTile(
            leading: Icon(
              seat.videoMuted
                  ? Icons.videocam_rounded
                  : Icons.videocam_off_rounded,
            ),
            title: Text(seat.videoMuted ? 'Allow camera' : 'Turn camera off'),
            onTap: () => _run(
              context,
              () => c.manageSeat(
                seat.index,
                seat.videoMuted ? 'camera_on' : 'camera_off',
              ),
            ),
          ),
        ListTile(
          leading: const Icon(Icons.call_end_rounded),
          title: const Text('Remove from stage'),
          onTap: () async {
            if (await _confirm(
              context,
              'Remove ${user.displayName} from the stage?',
              action: 'Remove',
            )) {
              if (context.mounted) {
                await _run(context, () => c.manageSeat(seat.index, 'remove'));
              }
            }
          },
        ),
      ],
      if (canModerate && seat == null && c.hasFreeSeat)
        ListTile(
          leading: const Icon(Icons.add_call),
          title: const Text('Invite to the stage'),
          onTap: () => _run(
            context,
            () => c.inviteToSeat(user.id),
            done: 'Invitation sent',
          ),
        ),
      // The host, platform moderators and `live.moderate` staff appoint room admins. The
      // server refuses taking the role from staff or a platform moderator.
      if (!me && role != RoomRole.host && (c.isHost || c.isLiveModerator))
        ListTile(
          leading: Icon(
            role == RoomRole.admin
                ? Icons.remove_moderator_outlined
                : Icons.add_moderator_outlined,
          ),
          title: Text(
            role == RoomRole.admin ? 'Remove as room admin' : 'Make room admin',
          ),
          subtitle: role == RoomRole.admin
              ? null
              : const Text('Admins can manage the stage and remove people'),
          onTap: () =>
              _run(context, () => c.setAdmin(user.id, role != RoomRole.admin)),
        ),
      if (canModerate) ...[
        ListTile(
          leading: const Icon(
            Icons.person_remove_alt_1_outlined,
            color: BBColors.danger,
          ),
          title: const Text(
            'Remove from live',
            style: TextStyle(color: BBColors.danger),
          ),
          subtitle: const Text('They can’t come back for an hour'),
          onTap: () async {
            if (await _confirm(
              context,
              'Remove ${user.displayName}?',
              action: 'Remove',
            )) {
              if (context.mounted) {
                await _run(context, () => c.kick(user.id), done: 'Removed');
              }
            }
          },
        ),
        if (c.isHost || c.canModerateLive)
          ListTile(
            leading: const Icon(Icons.block_rounded, color: BBColors.danger),
            title: Text(
              c.isHost ? 'Ban from my lives' : 'Ban from this host’s lives',
              style: const TextStyle(color: BBColors.danger),
            ),
            onTap: () async {
              if (await _confirm(
                context,
                'Ban ${user.displayName}?',
                message: c.isHost
                    ? 'They won’t be able to join any of your lives until you unban them.'
                    : 'They won’t be able to join any of ${c.detail?.room.host.displayName ?? 'this host'}’s lives until the ban is lifted.',
                action: 'Ban',
              )) {
                if (context.mounted) {
                  await _run(
                    context,
                    () => c.kick(user.id, banMinutes: null),
                    done: 'Banned',
                  );
                }
              }
            },
          ),
      ],
      // Platform moderators ban the account itself, app-wide (the server refuses
      // protected accounts with its own message).
      if (!me && ref.watch(meProvider).isPlatformModerator)
        ListTile(
          leading: const Icon(Icons.gavel_rounded, color: BBColors.danger),
          title: const Text(
            'Ban account',
            style: TextStyle(color: BBColors.danger),
          ),
          subtitle: const Text('Signs them out of the app'),
          onTap: () async {
            final banned = await BanSheet.show(context, user);
            if (banned != null && context.mounted && context.canPop()) {
              context.pop();
            }
          },
        ),
    ];

    return SafeArea(
      child: SingleChildScrollView(
        padding: const EdgeInsets.fromLTRB(20, 0, 20, 12),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            BBAvatar.user(user, size: 72),
            const SizedBox(height: 8),
            Row(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                Flexible(
                  child: Text(
                    user.displayName,
                    overflow: TextOverflow.ellipsis,
                    style: Theme.of(context).textTheme.titleLarge,
                  ),
                ),
                const SizedBox(width: 6),
                RoleBadge(role),
              ],
            ),
            const SizedBox(height: 4),
            Row(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                Text(
                  'ID ${user.shortId}',
                  style: const TextStyle(color: BBColors.inkMuted),
                ),
                const SizedBox(width: 8),
                LevelBadge(user.level),
                const SizedBox(width: 6),
                VipBadge(user.vipTier),
              ],
            ),
            const SizedBox(height: 8),
            // Seated people's balances follow the room's `balances` events; my own follows
            // `wallet:updated`; anyone else's is the profile's, as of opening the sheet.
            ListenableBuilder(
              listenable: c,
              builder: (_, _) {
                final live = c.detail?.seats
                    .where((s) => s.user?.id == user.id)
                    .firstOrNull
                    ?.diamonds;
                final diamonds = myDiamonds ?? live ?? profile.value?.diamonds;
                return diamonds == null
                    ? const SizedBox(height: 20)
                    : WalletBalance(diamonds);
              },
            ),
            const SizedBox(height: 16),
            Row(
              children: [
                Expanded(
                  child: OutlinedButton(
                    onPressed: () => context
                      ..pop()
                      ..push('/user/${user.id}'),
                    child: const Text('Profile'),
                  ),
                ),
                if (!me) ...[
                  const SizedBox(width: 10),
                  Expanded(
                    child: following
                        ? OutlinedButton(
                            onPressed: () async {
                              await ref
                                  .read(accountRepo)
                                  .follow(user.id, false)
                                  .catchError((Object _) {});
                              ref.invalidate(userProvider(user.id));
                            },
                            child: const Text('Following'),
                          )
                        : GoldButton(
                            label: 'Follow',
                            height: 40,
                            onPressed: () async {
                              await ref
                                  .read(accountRepo)
                                  .follow(user.id, true)
                                  .catchError((Object e) {
                                    if (context.mounted) showError(context, e);
                                  });
                              ref.invalidate(userProvider(user.id));
                            },
                          ),
                  ),
                ],
                // Anyone in the room can be gifted; the server checks they're still here.
                if (!me) ...[
                  const SizedBox(width: 10),
                  IconButton.filledTonal(
                    tooltip: 'Send a gift',
                    onPressed: () {
                      context.pop();
                      onGift(user);
                    },
                    icon: const Icon(Icons.card_giftcard_rounded),
                  ),
                ],
              ],
            ),
            if (!me)
              Align(
                child: TextButton(
                  onPressed: () => ReportSheet.show(
                    context,
                    targetType: 'user',
                    targetId: user.id,
                  ),
                  child: const Text('Report'),
                ),
              ),
            if (actions.isNotEmpty) ...[const Divider(), ...actions],
          ],
        ),
      ),
    );
  }
}

/// The tabs of [ParticipantsSheet].
enum ParticipantsTab { viewers, waiting, stage, admins }

/// VIEWS (who is watching), WAITING (the seat queue, oldest first), STAGE (who is on it)
/// and ADMINS (the room admins). WAITING is only for those who manage the stage
/// ([LiveRoomController.canManageStage]); the server refuses the queue to anyone else.
/// Everyone but the host gets their own seat action at the bottom: Join, Cancel request,
/// Go on stage (self-stage moderators) or Leave the stage.
class ParticipantsSheet extends ConsumerStatefulWidget {
  const ParticipantsSheet({
    super.key,
    required this.c,
    required this.onTapUser,
    this.onStageAction,
    this.initialTab = ParticipantsTab.viewers,
  });
  final LiveRoomController c;
  final void Function(UserBrief user) onTapUser;

  /// Asks for a seat, cancels the request, takes or leaves the stage (the screen's
  /// `_stageAction`, which also asks for camera and mic first). Null hides the pill.
  final Future<void> Function()? onStageAction;
  final ParticipantsTab initialTab;

  /// A hidden moderator gets no seat-queue pushes, so the open sheet polls it this often.
  static const pollEvery = Duration(seconds: 5);

  static Future<void> show(
    BuildContext context,
    LiveRoomController c, {
    required void Function(UserBrief user) onTapUser,
    Future<void> Function()? onStageAction,
    ParticipantsTab initialTab = ParticipantsTab.viewers,
  }) => showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    builder: (_) => ParticipantsSheet(
      c: c,
      onTapUser: onTapUser,
      onStageAction: onStageAction,
      initialTab: initialTab,
    ),
  );

  @override
  ConsumerState<ParticipantsSheet> createState() => _ParticipantsSheetState();
}

class _ParticipantsSheetState extends ConsumerState<ParticipantsSheet>
    with TickerProviderStateMixin {
  late Future<List<UserBrief>> _viewers = _loadViewers();
  late List<ParticipantsTab> _shown = _tabsFor();
  late TabController _tabs = TabController(
    length: _shown.length,
    vsync: this,
    initialIndex: math.max(0, _shown.indexOf(widget.initialTab)),
  );
  Timer? _poll;
  bool _acting = false;

  Future<List<UserBrief>> _loadViewers() =>
      ref.read(liveRepo).viewers(widget.c.roomId);

  LiveRoomController get c => widget.c;

  List<ParticipantsTab> _tabsFor() => [
    ParticipantsTab.viewers,
    if (c.canManageStage) ParticipantsTab.waiting,
    ParticipantsTab.stage,
    ParticipantsTab.admins,
  ];

  @override
  void initState() {
    super.initState();
    c.addListener(_changed);
    unawaited(c.refreshSeatRequests());
    _syncPolling();
  }

  @override
  void dispose() {
    c.removeListener(_changed);
    _poll?.cancel();
    _tabs.dispose();
    super.dispose();
  }

  /// Only a manager who isn't a room admin (a hidden moderator) needs to poll.
  void _syncPolling() {
    final poll = c.canManageStage && !c.isModerator;
    if (poll && _poll == null) {
      _poll = Timer.periodic(
        ParticipantsSheet.pollEvery,
        (_) => unawaited(c.refreshSeatRequests()),
      );
    } else if (!poll) {
      _poll?.cancel();
      _poll = null;
    }
  }

  void _changed() {
    if (!mounted) return;
    _syncPolling();
    final next = _tabsFor();
    if (next.length != _shown.length) {
      // Made (or no longer) a room admin while the sheet is open: WAITING comes or goes,
      // and the tab being read stays selected when it still exists.
      final current = _shown[_tabs.index];
      final old = _tabs;
      _shown = next;
      _tabs = TabController(
        length: next.length,
        vsync: this,
        initialIndex: math.max(0, next.indexOf(current)),
      );
      WidgetsBinding.instance.addPostFrameCallback((_) => old.dispose());
    }
    setState(() {});
  }

  void _open(UserBrief u) {
    context.pop();
    widget.onTapUser(u);
  }

  Future<void> _stageAction() async {
    final action = widget.onStageAction;
    if (action == null || _acting) return;
    setState(() => _acting = true);
    try {
      await action();
    } finally {
      if (mounted) setState(() => _acting = false);
    }
    // A request just sent: show where it sits in the queue.
    final waiting = _shown.indexOf(ParticipantsTab.waiting);
    if (mounted && c.seatRequestPending && waiting >= 0) {
      unawaited(c.refreshSeatRequests());
      _tabs.animateTo(waiting);
    }
  }

  Widget _viewersTab() => FutureBuilder<List<UserBrief>>(
    future: _viewers,
    builder: (context, snap) {
      if (snap.hasError) {
        return ErrorView(
          error: snap.error!,
          onRetry: () => setState(() => _viewers = _loadViewers()),
        );
      }
      final items = snap.data;
      if (items == null) {
        return const Center(child: CircularProgressIndicator());
      }
      if (items.isEmpty) {
        return const EmptyState(
          icon: Icons.visibility_outlined,
          title: 'No viewers yet',
        );
      }
      return RefreshIndicator(
        onRefresh: () async {
          final next = _loadViewers();
          setState(() => _viewers = next);
          await next;
        },
        child: ListView(
          children: [
            for (final v in items)
              UserTile(
                user: v,
                onTap: () => _open(v),
                trailing:
                    c.canManageStage &&
                        v.id != c.myUid &&
                        c.roleOf(v.id) != RoomRole.guest &&
                        c.hasFreeSeat
                    ? TextButton(
                        onPressed: () => _run(
                          context,
                          () => c.inviteToSeat(v.id),
                          done: 'Invitation sent',
                        ),
                        child: const Text('Invite'),
                      )
                    : RoleBadge(c.roleOf(v.id)),
              ),
          ],
        ),
      );
    },
  );

  Future<void> _decide(SeatRequest r, bool accept) =>
      c.decideSeat(r.user.id, accept).catchError((Object e) {
        if (mounted) showError(context, e);
      });

  Widget _waitingTab() {
    final requests = c.seatRequests;
    return RefreshIndicator(
      onRefresh: c.refreshSeatRequests,
      child: ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        children: [
          if (requests.isEmpty)
            const Padding(
              padding: EdgeInsets.only(top: 48),
              child: EmptyState(
                icon: Icons.event_seat_outlined,
                title: 'No one is waiting',
                message: 'Viewers who ask to join the stage show up here.',
              ),
            ),
          if (requests.isNotEmpty && !c.hasFreeSeat)
            const Padding(
              padding: EdgeInsets.all(12),
              child: Text(
                'The stage is full. Remove someone to accept a request.',
                style: TextStyle(color: BBColors.warning),
              ),
            ),
          for (final (i, r) in requests.indexed)
            _WaitingTile(
              position: i + 1,
              request: r,
              mine: r.user.id == c.myUid,
              canAccept: c.hasFreeSeat,
              onTap: () => _open(r.user),
              onDecline: () => _decide(r, false),
              onAccept: () => _decide(r, true),
            ),
        ],
      ),
    );
  }

  Widget _stageTab() {
    final stage = c.stage;
    return ListView(
      children: [
        for (final s in stage)
          UserTile(
            user: s.user!,
            subtitle: s.index == 0 ? 'Host' : 'Seat ${s.index + 1}',
            onTap: () => _open(s.user!),
            trailing: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                if (s.muted)
                  const Icon(Icons.mic_off, color: BBColors.danger, size: 18),
                if (s.videoMuted)
                  const Icon(
                    Icons.videocam_off,
                    color: BBColors.danger,
                    size: 18,
                  ),
                RoleBadge(c.roleOf(s.user!.id)),
              ],
            ),
          ),
      ],
    );
  }

  Widget _adminsTab() {
    final admins = c.detail?.moderators ?? const <UserBrief>[];
    // The host, platform moderators and `live.moderate` staff take the role back; the
    // server refuses it for protected accounts.
    final canRevoke = c.isHost || c.isLiveModerator;
    return ListView(
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 12, 16, 4),
          child: Text(
            c.isHost
                ? 'Room admins can accept seat requests, manage the stage and remove people. '
                      'Make someone an admin from their profile card.'
                : 'Room admins help the host keep the live friendly.',
            style: const TextStyle(color: BBColors.inkMuted, fontSize: 13),
          ),
        ),
        if (admins.isEmpty)
          const EmptyState(
            icon: Icons.shield_outlined,
            title: 'No room admins',
          ),
        for (final a in admins)
          UserTile(
            user: a,
            onTap: () => _open(a),
            trailing: canRevoke && a.id != c.myUid
                ? TextButton(
                    onPressed: () =>
                        _run(context, () => c.setAdmin(a.id, false)),
                    child: const Text('Remove'),
                  )
                : null,
          ),
      ],
    );
  }

  String _label(ParticipantsTab t) => switch (t) {
    ParticipantsTab.viewers => 'VIEWS ${c.viewerCount}',
    ParticipantsTab.waiting => 'WAITING ${c.seatRequests.length}',
    ParticipantsTab.stage => 'STAGE ${c.stage.length}',
    ParticipantsTab.admins => 'ADMINS ${c.detail?.moderators.length ?? 0}',
  };

  Widget _body(ParticipantsTab t) => switch (t) {
    ParticipantsTab.viewers => _viewersTab(),
    ParticipantsTab.waiting => _waitingTab(),
    ParticipantsTab.stage => _stageTab(),
    ParticipantsTab.admins => _adminsTab(),
  };

  @override
  Widget build(BuildContext context) {
    final showPill = widget.onStageAction != null && !c.isHost;
    return SafeArea(
      child: SizedBox(
        height: MediaQuery.sizeOf(context).height * 0.65,
        child: Column(
          children: [
            TabBar(
              controller: _tabs,
              isScrollable: true,
              tabAlignment: TabAlignment.center,
              indicatorColor: BBColors.gold,
              indicatorSize: TabBarIndicatorSize.label,
              labelColor: BBColors.ink,
              unselectedLabelColor: BBColors.inkSubtle,
              dividerColor: BBColors.border,
              labelStyle: const TextStyle(
                fontWeight: FontWeight.w800,
                letterSpacing: 0.6,
              ),
              tabs: [for (final t in _shown) Tab(text: _label(t))],
            ),
            Expanded(
              child: TabBarView(
                controller: _tabs,
                children: [for (final t in _shown) _body(t)],
              ),
            ),
            if (showPill)
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 8, 16, 8),
                child: _StagePill(
                  label: c.onSeat
                      ? 'Leave the stage'
                      : c.seatRequestPending
                      ? 'Cancel request'
                      : c.canSelfStage
                      ? 'Go on stage'
                      : 'Join',
                  icon: c.onSeat
                      ? Icons.call_end_rounded
                      : c.seatRequestPending
                      ? Icons.close_rounded
                      : Icons.mic_rounded,
                  quiet: c.seatRequestPending,
                  danger: c.onSeat,
                  busy: _acting,
                  onTap: _stageAction,
                ),
              ),
          ],
        ),
      ),
    );
  }
}

/// One row of the seat queue: its place, the person, and Decline / Approve for managers.
class _WaitingTile extends StatelessWidget {
  const _WaitingTile({
    required this.position,
    required this.request,
    required this.mine,
    required this.canAccept,
    required this.onTap,
    required this.onDecline,
    required this.onAccept,
  });
  final int position;
  final SeatRequest request;
  final bool mine;
  final bool canAccept;
  final VoidCallback onTap;
  final VoidCallback onDecline;
  final VoidCallback onAccept;

  @override
  Widget build(BuildContext context) {
    final u = request.user;
    return ListTile(
      onTap: onTap,
      leading: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          SizedBox(
            width: 24,
            child: Text(
              '$position',
              style: const TextStyle(
                color: BBColors.goldDeep,
                fontWeight: FontWeight.w800,
              ),
            ),
          ),
          BBAvatar.user(u),
        ],
      ),
      title: Row(
        children: [
          Flexible(
            child: Text(
              u.displayName,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(fontWeight: FontWeight.w700),
            ),
          ),
          const SizedBox(width: 6),
          VipBadge(u.vipTier),
        ],
      ),
      subtitle: Text(
        'ID ${u.shortId} · Lv ${u.level}${mine ? ' · You' : ''}',
        style: const TextStyle(color: BBColors.inkSubtle),
      ),
      trailing: mine
          ? null
          : Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                IconButton(
                  tooltip: 'Decline',
                  icon: const Icon(Icons.close_rounded, color: BBColors.danger),
                  onPressed: onDecline,
                ),
                IconButton(
                  tooltip: 'Approve',
                  icon: const Icon(
                    Icons.check_circle_rounded,
                    color: BBColors.success,
                  ),
                  onPressed: canAccept ? onAccept : null,
                ),
              ],
            ),
    );
  }
}

/// My own seat action under the participants tabs: a gold pill, a quiet one while my
/// request waits, a red one to leave the stage.
class _StagePill extends StatelessWidget {
  const _StagePill({
    required this.label,
    required this.icon,
    required this.onTap,
    this.quiet = false,
    this.danger = false,
    this.busy = false,
  });
  final String label;
  final IconData icon;
  final VoidCallback onTap;
  final bool quiet;
  final bool danger;
  final bool busy;

  static const height = 46.0;

  @override
  Widget build(BuildContext context) {
    final radius = BorderRadius.circular(height / 2);
    final fg = quiet ? BBColors.ink : BBColors.onAccent;
    return Semantics(
      button: true,
      label: label,
      excludeSemantics: true,
      child: Material(
        color: Colors.transparent,
        child: Ink(
          height: height,
          decoration: BoxDecoration(
            borderRadius: radius,
            gradient: quiet || danger ? null : BBColors.goldGradient,
            color: quiet
                ? BBColors.surfaceMuted
                : danger
                ? BBColors.danger
                : null,
            border: quiet ? Border.all(color: BBColors.border) : null,
          ),
          child: InkWell(
            borderRadius: radius,
            onTap: busy ? null : onTap,
            child: Center(
              child: busy
                  ? SizedBox.square(
                      dimension: 20,
                      child: CircularProgressIndicator(
                        strokeWidth: 2,
                        color: fg,
                      ),
                    )
                  : Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Icon(icon, color: fg, size: 20),
                        const SizedBox(width: 8),
                        Text(
                          label,
                          style: TextStyle(
                            color: fg,
                            fontWeight: FontWeight.w800,
                            fontSize: 15,
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

/// Host-only: lock the live against new viewers, optionally with a numeric password.
class LockSheet extends StatefulWidget {
  const LockSheet({super.key, required this.c});
  final LiveRoomController c;

  static Future<void> show(BuildContext context, LiveRoomController c) =>
      showModalBottomSheet<void>(
        context: context,
        isScrollControlled: true,
        builder: (_) => Padding(
          padding: EdgeInsets.only(
            bottom: MediaQuery.viewInsetsOf(context).bottom,
          ),
          child: LockSheet(c: c),
        ),
      );

  @override
  State<LockSheet> createState() => _LockSheetState();
}

class _LockSheetState extends State<LockSheet> {
  late bool _locked = widget.c.locked;
  late bool _usePassword = widget.c.detail?.room.hasPassword ?? false;
  final _password = TextEditingController();
  bool _saving = false;

  @override
  void dispose() {
    _password.dispose();
    super.dispose();
  }

  bool get _keepsPassword =>
      _usePassword &&
      _password.text.isEmpty &&
      (widget.c.detail?.room.hasPassword ?? false);
  bool get _valid =>
      !_locked ||
      !_usePassword ||
      _keepsPassword ||
      RegExp(r'^\d{4,6}$').hasMatch(_password.text);

  Future<void> _save() async {
    setState(() => _saving = true);
    try {
      // Still locked with the existing password: nothing to change.
      if (_keepsPassword) {
        if (mounted) context.pop();
        return;
      }
      await widget.c.setLock(
        locked: _locked,
        password: _locked && _usePassword ? _password.text : null,
      );
      if (!mounted) return;
      showMessage(
        context,
        _locked
            ? (_usePassword
                  ? 'Locked — viewers need the password'
                  : 'Locked — no new viewers can join')
            : 'Unlocked',
      );
      context.pop();
    } catch (e) {
      if (mounted) showError(context, e);
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  @override
  Widget build(BuildContext context) => SafeArea(
    child: Padding(
      padding: const EdgeInsets.fromLTRB(20, 0, 20, 16),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Text(
            'Lock this live',
            style: TextStyle(fontWeight: FontWeight.w800, fontSize: 18),
          ),
          const SizedBox(height: 4),
          const Text(
            'People already watching stay. Room admins can still join.',
            style: TextStyle(color: BBColors.inkMuted),
          ),
          SwitchListTile(
            contentPadding: EdgeInsets.zero,
            value: _locked,
            title: const Text('Locked'),
            secondary: Icon(
              _locked ? Icons.lock_rounded : Icons.lock_open_rounded,
            ),
            onChanged: (v) => setState(() => _locked = v),
          ),
          if (_locked) ...[
            CheckboxListTile(
              contentPadding: EdgeInsets.zero,
              value: _usePassword,
              title: const Text('Let people in with a password'),
              onChanged: (v) => setState(() => _usePassword = v ?? false),
            ),
            if (_usePassword)
              TextField(
                controller: _password,
                keyboardType: TextInputType.number,
                maxLength: 6,
                obscureText: true,
                onChanged: (_) => setState(() {}),
                decoration: InputDecoration(
                  labelText: 'Password (4–6 digits)',
                  helperText: (widget.c.detail?.room.hasPassword ?? false)
                      ? 'Enter a password to set it (the current one is hidden)'
                      : null,
                ),
              ),
          ],
          const SizedBox(height: 12),
          GoldButton(
            label: 'Save',
            loading: _saving,
            onPressed: _valid && !_saving ? _save : null,
          ),
        ],
      ),
    ),
  );
}

/// Tapping an empty audio-room seat: viewers ask for it; anyone who manages the stage (host,
/// room admins, platform moderators even when hidden) invites to it or locks / opens it.
Future<void> showEmptySeatSheet(
  BuildContext context,
  LiveRoomController c,
  Seat seat, {
  required VoidCallback onInvite,
}) => showModalBottomSheet<void>(
  context: context,
  builder: (ctx) => SafeArea(
    child: Wrap(
      children: [
        if (c.canManageStage) ...[
          if (!seat.locked)
            ListTile(
              leading: const Icon(Icons.person_add_alt_1_outlined),
              title: const Text('Invite someone'),
              onTap: () {
                ctx.pop();
                onInvite();
              },
            ),
          ListTile(
            leading: Icon(
              seat.locked ? Icons.lock_open_rounded : Icons.lock_outline,
            ),
            title: Text(seat.locked ? 'Open this seat' : 'Lock this seat'),
            onTap: () => _run(
              ctx,
              () => c.manageSeat(seat.index, seat.locked ? 'unlock' : 'lock'),
            ),
          ),
        ] else if (seat.locked)
          const ListTile(
            leading: Icon(Icons.lock_outline),
            title: Text('This seat is locked'),
          )
        else if (!c.onSeat)
          ListTile(
            leading: const Icon(Icons.event_seat_rounded),
            title: Text(
              c.seatRequestPending ? 'Request sent' : 'Ask to take a seat',
            ),
            enabled: !c.seatRequestPending,
            onTap: () =>
                _run(ctx, c.requestSeat, done: 'Request sent to the host'),
          ),
      ],
    ),
  ),
);

/// The rail's "More": the viewer list, the stage (host and admins) and Report.
class LiveMoreSheet {
  static Future<void> show(
    BuildContext context,
    LiveRoomController c, {
    required void Function([ParticipantsTab tab]) onParticipants,
  }) => showModalBottomSheet<void>(
    context: context,
    showDragHandle: true,
    builder: (ctx) {
      void then(VoidCallback action) {
        ctx.pop();
        action();
      }

      return SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            const Padding(
              padding: EdgeInsets.fromLTRB(20, 0, 20, 8),
              child: Text(
                'More',
                style: TextStyle(fontSize: 17, fontWeight: FontWeight.w700),
              ),
            ),
            ListTile(
              leading: const Icon(Icons.people_alt_rounded),
              title: const Text('Viewers'),
              onTap: () => then(onParticipants),
            ),
            if (c.canManageStage)
              ListTile(
                leading: const Icon(Icons.event_seat_rounded),
                title: const Text('Stage'),
                onTap: () => then(() => onParticipants(ParticipantsTab.stage)),
              ),
            if (!c.isHost)
              ListTile(
                leading: const Icon(Icons.flag_rounded, color: BBColors.danger),
                title: const Text('Report live'),
                onTap: () => then(
                  () => ReportSheet.show(
                    context,
                    targetType: 'room',
                    targetId: c.roomId,
                  ),
                ),
              ),
          ],
        ),
      );
    },
  );
}
