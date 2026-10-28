import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/providers.dart';
import '../../core/theme/bb_colors.dart';
import '../../core/widgets/widgets.dart';
import '../../models/models.dart';
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
    final onStage = role == RoomRole.host || seat != null;
    // Admins can't act on the host or on each other; the server enforces the same.
    final canModerate =
        !me &&
        role != RoomRole.host &&
        (myRole == RoomRole.host ||
            (myRole == RoomRole.admin && role != RoomRole.admin));
    final profile = ref.watch(userProvider(user.id));
    final following = profile.value?.isFollowing ?? false;

    final actions = <Widget>[
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
      if (c.isHost && !me)
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
        if (c.isHost)
          ListTile(
            leading: const Icon(Icons.block_rounded, color: BBColors.danger),
            title: const Text(
              'Ban from my lives',
              style: TextStyle(color: BBColors.danger),
            ),
            onTap: () async {
              if (await _confirm(
                context,
                'Ban ${user.displayName}?',
                message: 'They won’t be able to join any of your lives until you unban them.',
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
                if (!me && onStage) ...[
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

/// Viewers, the stage, seat requests (host/admins) and room admins in one sheet.
class ParticipantsSheet extends ConsumerStatefulWidget {
  const ParticipantsSheet({
    super.key,
    required this.c,
    required this.onTapUser,
    this.initialTab = 0,
  });
  final LiveRoomController c;
  final void Function(UserBrief user) onTapUser;
  final int initialTab;

  static const requestsTab = 2;

  static Future<void> show(
    BuildContext context,
    LiveRoomController c, {
    required void Function(UserBrief user) onTapUser,
    int initialTab = 0,
  }) => showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    builder: (_) =>
        ParticipantsSheet(c: c, onTapUser: onTapUser, initialTab: initialTab),
  );

  @override
  ConsumerState<ParticipantsSheet> createState() => _ParticipantsSheetState();
}

class _ParticipantsSheetState extends ConsumerState<ParticipantsSheet> {
  late Future<List<UserBrief>> _viewers = _loadViewers();

  Future<List<UserBrief>> _loadViewers() =>
      ref.read(liveRepo).viewers(widget.c.roomId);

  LiveRoomController get c => widget.c;

  @override
  void initState() {
    super.initState();
    c.addListener(_changed);
  }

  @override
  void dispose() {
    c.removeListener(_changed);
    super.dispose();
  }

  void _changed() {
    if (mounted) setState(() {});
  }

  void _open(UserBrief u) {
    context.pop();
    widget.onTapUser(u);
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
                    c.isModerator &&
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

  Widget _requestsTab() {
    final requests = c.seatRequests;
    if (requests.isEmpty) {
      return const EmptyState(
        icon: Icons.event_seat_outlined,
        title: 'No requests',
        message: 'Viewers who ask to join the stage show up here.',
      );
    }
    return ListView(
      children: [
        if (!c.hasFreeSeat)
          const Padding(
            padding: EdgeInsets.all(12),
            child: Text(
              'The stage is full. Remove someone to accept a request.',
              style: TextStyle(color: BBColors.warning),
            ),
          ),
        for (final r in requests)
          UserTile(
            user: r.user,
            onTap: () => _open(r.user),
            trailing: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                IconButton(
                  tooltip: 'Decline',
                  icon: const Icon(Icons.close),
                  onPressed: () =>
                      c.decideSeat(r.user.id, false).catchError((Object e) {
                        if (mounted) showError(context, e);
                      }),
                ),
                IconButton(
                  tooltip: 'Accept',
                  icon: const Icon(Icons.check_circle, color: BBColors.success),
                  onPressed: c.hasFreeSeat
                      ? () => c.decideSeat(r.user.id, true).catchError((
                          Object e,
                        ) {
                          if (mounted) showError(context, e);
                        })
                      : null,
                ),
              ],
            ),
          ),
      ],
    );
  }

  Widget _adminsTab() {
    final admins = c.detail?.moderators ?? const <UserBrief>[];
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
            trailing: c.isHost
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

  @override
  Widget build(BuildContext context) {
    final tabs = <(String, Widget)>[
      ('Viewers ${c.viewerCount}', _viewersTab()),
      ('Stage ${c.stage.length}', _stageTab()),
      if (c.isModerator) ('Requests ${c.seatRequests.length}', _requestsTab()),
      ('Admins', _adminsTab()),
    ];
    final initial =
        widget.initialTab == ParticipantsSheet.requestsTab && !c.isModerator
        ? 0
        : widget.initialTab.clamp(0, tabs.length - 1);
    return SafeArea(
      child: SizedBox(
        height: MediaQuery.sizeOf(context).height * 0.65,
        child: DefaultTabController(
          length: tabs.length,
          initialIndex: initial,
          child: Column(
            children: [
              TabBar(
                isScrollable: true,
                tabAlignment: TabAlignment.start,
                tabs: [for (final t in tabs) Tab(text: t.$1)],
              ),
              Expanded(
                child: TabBarView(children: [for (final t in tabs) t.$2]),
              ),
            ],
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

/// Tapping an empty audio-room seat: viewers ask for it; the host and admins lock or open it.
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
        if (c.isModerator) ...[
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
