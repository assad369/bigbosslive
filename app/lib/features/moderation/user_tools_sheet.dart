import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/network/api_client.dart';
import '../../core/providers.dart';
import '../../core/theme/bb_colors.dart';
import '../../core/utils/format.dart';
import '../../core/widgets/widgets.dart';
import '../../models/models.dart';
import 'ban_sheet.dart';

/// What a platform moderator can look into for one account: its profile, the devices it
/// signed in from (with device bans), and the hosts who banned it from their lives.
class UserToolsSheet extends StatelessWidget {
  const UserToolsSheet({super.key, required this.row});
  final ModeratedUser row;

  static Future<void> show(BuildContext context, ModeratedUser row) =>
      showModalBottomSheet<void>(
        context: context,
        builder: (_) => UserToolsSheet(row: row),
      );

  @override
  Widget build(BuildContext context) => SafeArea(
    child: Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        ListTile(
          leading: BBAvatar.user(row.user, size: 40),
          title: Text(row.user.displayName),
          subtitle: Text('ID ${row.user.shortId}'),
        ),
        const Divider(height: 1),
        ListTile(
          leading: const Icon(Icons.person_outline_rounded),
          title: const Text('View profile'),
          onTap: () => context
            ..pop()
            ..push('/user/${row.id}'),
        ),
        ListTile(
          leading: const Icon(Icons.smartphone_rounded),
          title: const Text('Devices'),
          subtitle: const Text('Where this account signed in'),
          onTap: () => context
            ..pop()
            ..push('/moderation/${row.id}/devices', extra: row.user),
        ),
        ListTile(
          leading: const Icon(Icons.no_accounts_outlined),
          title: const Text('Live bans'),
          subtitle: const Text(
            'Hosts who banned this account from their lives',
          ),
          onTap: () => context
            ..pop()
            ..push('/moderation/${row.id}/live-bans', extra: row.user),
        ),
      ],
    ),
  );
}

final _devicesProvider = FutureProvider.autoDispose
    .family<List<ModeratedDevice>, String>(
      (ref, uid) => ref.read(moderationRepo).devices(uid),
    );

final _roomBansProvider = FutureProvider.autoDispose
    .family<List<ModeratedRoomBan>, String>(
      (ref, uid) => ref.read(moderationRepo).roomBans(uid),
    );

/// The devices one account signed in from. A device ban also bans every account on it;
/// the moderator's own handset is never offered.
class UserDevicesScreen extends ConsumerStatefulWidget {
  const UserDevicesScreen({super.key, required this.uid, this.user});
  final String uid;
  final UserBrief? user;

  @override
  ConsumerState<UserDevicesScreen> createState() => _UserDevicesScreenState();
}

class _UserDevicesScreenState extends ConsumerState<UserDevicesScreen> {
  /// One key per device the moderator means to ban, kept across retries of that ban.
  final _keys = <String, String>{};
  final _busy = <String>{};

  Future<void> _ban(ModeratedDevice d) async {
    final reason = await _askReason(d);
    if (reason == null || !mounted) return;
    final key = _keys.putIfAbsent(d.deviceId, ApiClient.newIdempotencyKey);
    setState(() => _busy.add(d.deviceId));
    try {
      final res = await ref
          .read(moderationRepo)
          .banDevice(d.deviceId, reason: reason, idempotencyKey: key);
      _keys.remove(d.deviceId);
      if (!mounted) return;
      showMessage(
        context,
        'Device banned · ${res.accountsBanned} account(s) banned'
        '${res.skipped.isEmpty ? '' : ' · ${res.skipped.length} skipped'}',
      );
      ref.invalidate(_devicesProvider(widget.uid));
    } catch (e) {
      if (mounted) showError(context, e);
    } finally {
      if (mounted) setState(() => _busy.remove(d.deviceId));
    }
  }

  Future<String?> _askReason(ModeratedDevice d) {
    final text = TextEditingController();
    return showDialog<String>(
      context: context,
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, setLocal) => AlertDialog(
          title: const Text('Ban this device?'),
          content: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(
                'All ${d.accountCount} account(s) that signed in on it will be banned too. '
                'Only staff can unban a device.',
              ),
              const SizedBox(height: 12),
              TextField(
                controller: text,
                autofocus: true,
                maxLength: 200,
                decoration: const InputDecoration(labelText: 'Reason'),
                onChanged: (_) => setLocal(() {}),
              ),
            ],
          ),
          actions: [
            TextButton(onPressed: () => ctx.pop(), child: const Text('Cancel')),
            FilledButton(
              style: FilledButton.styleFrom(backgroundColor: BBColors.danger),
              onPressed: validBanReason(text.text)
                  ? () => ctx.pop(text.text.trim())
                  : null,
              child: const Text('Ban device'),
            ),
          ],
        ),
      ),
    ).whenComplete(text.dispose);
  }

  @override
  Widget build(BuildContext context) {
    final devices = ref.watch(_devicesProvider(widget.uid));
    return Scaffold(
      appBar: AppBar(
        title: Text(
          widget.user == null
              ? 'Devices'
              : '${widget.user!.displayName}’s devices',
        ),
      ),
      body: AsyncView(
        value: devices,
        onRetry: () => ref.invalidate(_devicesProvider(widget.uid)),
        data: (items) => items.isEmpty
            ? const EmptyState(
                icon: Icons.smartphone_rounded,
                title: 'No devices recorded',
              )
            : ListView.separated(
                itemCount: items.length,
                separatorBuilder: (_, _) => const Divider(height: 1),
                itemBuilder: (_, i) {
                  final d = items[i];
                  return ListTile(
                    leading: Icon(
                      d.platform == 'ios'
                          ? Icons.phone_iphone_rounded
                          : Icons.phone_android_rounded,
                    ),
                    title: Text(
                      d.deviceId,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                    ),
                    subtitle: Text(
                      [
                        d.platform ?? 'Unknown',
                        '${d.accountCount} account(s)',
                        if (d.lastSeenAt != null) Fmt.ago(d.lastSeenAt),
                        if (d.isYours) 'Your device',
                      ].join(' · '),
                    ),
                    trailing: d.banned
                        ? const Text(
                            'Banned',
                            style: TextStyle(
                              color: BBColors.danger,
                              fontWeight: FontWeight.w700,
                            ),
                          )
                        : d.isYours
                        ? null
                        : _busy.contains(d.deviceId)
                        ? const SizedBox.square(
                            dimension: 22,
                            child: CircularProgressIndicator(strokeWidth: 2),
                          )
                        : OutlinedButton(
                            onPressed: () => _ban(d),
                            child: const Text('Ban'),
                          ),
                  );
                },
              ),
      ),
    );
  }
}

/// Hosts who banned one account from their lives, each with Lift.
class UserLiveBansScreen extends ConsumerWidget {
  const UserLiveBansScreen({super.key, required this.uid, this.user});
  final String uid;
  final UserBrief? user;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final bans = ref.watch(_roomBansProvider(uid));
    return Scaffold(
      appBar: AppBar(title: const Text('Live bans')),
      body: AsyncView(
        value: bans,
        onRetry: () => ref.invalidate(_roomBansProvider(uid)),
        data: (items) => items.isEmpty
            ? EmptyState(
                icon: Icons.verified_user_outlined,
                title: 'No live bans',
                message: user == null
                    ? null
                    : 'No host has banned ${user!.displayName} from their lives.',
              )
            : ListView.separated(
                itemCount: items.length,
                separatorBuilder: (_, _) => const Divider(height: 1),
                itemBuilder: (_, i) {
                  final b = items[i];
                  final until = b.until;
                  return ListTile(
                    leading: b.host == null
                        ? const CircleAvatar(child: Icon(Icons.person))
                        : BBAvatar.user(b.host!, size: 40),
                    title: Text(b.host?.displayName ?? b.hostId),
                    subtitle: Text(
                      until == null
                          ? 'Until lifted'
                          : 'Until ${Fmt.dateTime(until)}',
                    ),
                    trailing: OutlinedButton(
                      onPressed: () async {
                        try {
                          await ref
                              .read(moderationRepo)
                              .liftRoomBan(b.hostId, uid);
                          ref.invalidate(_roomBansProvider(uid));
                          if (context.mounted) {
                            showMessage(context, 'Live ban lifted');
                          }
                        } catch (e) {
                          if (context.mounted) showError(context, e);
                        }
                      },
                      child: const Text('Lift'),
                    ),
                  );
                },
              ),
      ),
    );
  }
}
