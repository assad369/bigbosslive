import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/network/api_client.dart';
import '../../core/providers.dart';
import '../../core/theme/bb_colors.dart';
import '../../core/widgets/widgets.dart';
import '../../models/models.dart';

/// How long a ban lasts. Mirrors `MODERATOR_BAN_DAYS` on the server; null = until lifted.
const banDurations = <(int?, String)>[
  (1, '1 day'),
  (7, '7 days'),
  (30, '30 days'),
  (null, 'Permanent'),
];

/// The server's reason bounds (`moderatorBanInput`).
bool validBanReason(String reason) {
  final r = reason.trim();
  return r.length >= 3 && r.length <= 200;
}

/// Bans one account: a required reason, a length, and optionally every device it signed in
/// from. Pops the updated [ModeratedUser] on success, null when dismissed.
///
/// One idempotency key per sheet: a retry after a timeout reuses it, so the account (and its
/// devices) is never banned twice, and a fresh sheet is a fresh intent.
class BanSheet extends ConsumerStatefulWidget {
  const BanSheet({super.key, required this.user});
  final UserBrief user;

  static Future<ModeratedUser?> show(BuildContext context, UserBrief user) =>
      showModalBottomSheet<ModeratedUser>(
        context: context,
        isScrollControlled: true,
        builder: (_) => BanSheet(user: user),
      );

  @override
  ConsumerState<BanSheet> createState() => _BanSheetState();
}

class _BanSheetState extends ConsumerState<BanSheet> {
  final _reason = TextEditingController();
  int? _days = 7;

  /// Off by default: a device ban reaches every account on those devices and isn't undone
  /// by lifting this ban, so it must be a deliberate choice each time.
  bool _banDevices = false;
  bool _busy = false;
  late final String _key = ApiClient.newIdempotencyKey();

  @override
  void dispose() {
    _reason.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (_busy || !validBanReason(_reason.text)) return;
    final repo = ref.read(moderationRepo);
    setState(() => _busy = true);
    try {
      if (_banDevices) {
        final preview = await repo.deviceBanPreview(widget.user.id);
        if (!mounted) return;
        if (!await _confirmCascade(preview)) return;
      }
      final res = await repo.ban(
        widget.user.id,
        reason: _reason.text.trim(),
        days: _days,
        banDevices: _banDevices,
        idempotencyKey: _key,
      );
      if (!mounted) return;
      final d = res.devices;
      showMessage(
        context,
        d == null
            ? '${widget.user.displayName} is banned'
            : 'Banned ${d.accountsBanned + 1} account(s) and ${d.devicesBanned} device(s)'
                  '${d.skipped.isEmpty ? '' : ' · ${d.skipped.length} skipped'}',
      );
      context.pop(res.user);
    } catch (e) {
      if (mounted) showError(context, e);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  /// Shows what a device ban would do; a big one needs a second, explicit confirmation.
  Future<bool> _confirmCascade(DeviceBanPreview p) async {
    final big = p.accounts > 5;
    var sure = !big;
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, setLocal) => AlertDialog(
          title: const Text('Ban devices too?'),
          content: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  '${p.devices} device(s) and ${p.accounts} account(s) will be banned'
                  '${p.alreadyBanned > 0 ? ' (${p.alreadyBanned} already banned)' : ''}. '
                  'Lifting this ban later won’t unban the devices or the other accounts.',
                ),
                if (p.skipped.isNotEmpty) ...[
                  const SizedBox(height: 12),
                  const Text(
                    'Not banned:',
                    style: TextStyle(fontWeight: FontWeight.w700),
                  ),
                  for (final s in p.skipped.take(5))
                    Text(
                      '• ${s.user?.displayName ?? s.uid}: ${s.reason}',
                      style: const TextStyle(color: BBColors.inkMuted),
                    ),
                  if (p.skipped.length > 5)
                    Text(
                      '…and ${p.skipped.length - 5} more',
                      style: const TextStyle(color: BBColors.inkMuted),
                    ),
                ],
                if (big) ...[
                  const SizedBox(height: 8),
                  CheckboxListTile(
                    contentPadding: EdgeInsets.zero,
                    value: sure,
                    onChanged: (v) => setLocal(() => sure = v ?? false),
                    title: Text('Yes, ban ${p.accounts} accounts'),
                  ),
                ],
              ],
            ),
          ),
          actions: [
            TextButton(
              onPressed: () => ctx.pop(false),
              child: const Text('Cancel'),
            ),
            FilledButton(
              style: FilledButton.styleFrom(backgroundColor: BBColors.danger),
              onPressed: sure ? () => ctx.pop(true) : null,
              child: const Text('Ban all'),
            ),
          ],
        ),
      ),
    );
    return ok ?? false;
  }

  @override
  Widget build(BuildContext context) {
    final valid = validBanReason(_reason.text);
    return Padding(
      padding: EdgeInsets.only(bottom: MediaQuery.viewInsetsOf(context).bottom),
      child: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.fromLTRB(20, 0, 20, 16),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text(
                'Ban ${widget.user.displayName}?',
                style: Theme.of(context).textTheme.titleLarge,
              ),
              const SizedBox(height: 4),
              const Text(
                'They’re signed out at once and can’t use the app. The reason is kept for review.',
                style: TextStyle(color: BBColors.inkMuted),
              ),
              const SizedBox(height: 16),
              TextField(
                key: const Key('ban-reason'),
                controller: _reason,
                autofocus: true,
                maxLines: 3,
                maxLength: 200,
                textCapitalization: TextCapitalization.sentences,
                decoration: const InputDecoration(
                  labelText: 'Reason (required)',
                  hintText: 'What did they do?',
                ),
                onChanged: (_) => setState(() {}),
              ),
              const SizedBox(height: 8),
              const Text(
                'How long',
                style: TextStyle(fontWeight: FontWeight.w700),
              ),
              const SizedBox(height: 6),
              Wrap(
                spacing: 8,
                runSpacing: 8,
                children: [
                  for (final (days, label) in banDurations)
                    ChoiceChip(
                      label: Text(label),
                      selected: _days == days,
                      onSelected: _busy
                          ? null
                          : (_) => setState(() => _days = days),
                    ),
                ],
              ),
              const SizedBox(height: 12),
              SwitchListTile(
                contentPadding: EdgeInsets.zero,
                value: _banDevices,
                onChanged: _busy
                    ? null
                    : (v) => setState(() => _banDevices = v),
                title: const Text('Also ban their devices'),
                subtitle: const Text(
                  'Every account that signed in on those devices is banned too. '
                  'You’ll see who before anything happens.',
                ),
              ),
              const SizedBox(height: 12),
              FilledButton(
                key: const Key('ban-submit'),
                style: FilledButton.styleFrom(
                  backgroundColor: BBColors.danger,
                  minimumSize: const Size.fromHeight(48),
                ),
                onPressed: valid && !_busy ? _submit : null,
                child: _busy
                    ? const SizedBox.square(
                        dimension: 20,
                        child: CircularProgressIndicator(
                          strokeWidth: 2,
                          color: BBColors.onAccent,
                        ),
                      )
                    : Text(_banDevices ? 'Continue' : 'Ban'),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
