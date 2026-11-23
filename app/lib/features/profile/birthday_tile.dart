import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:intl/intl.dart';

import '../../core/providers.dart';
import '../../core/theme/bb_colors.dart';
import '../../core/widgets/widgets.dart';

/// The date of birth in Edit profile: optional, given once, never shown to others. It gates
/// nothing.
class BirthdayTile extends ConsumerStatefulWidget {
  const BirthdayTile({super.key, this.today});

  /// Fixed in tests; otherwise the device date.
  final DateTime? today;

  @override
  ConsumerState<BirthdayTile> createState() => _BirthdayTileState();
}

class _BirthdayTileState extends ConsumerState<BirthdayTile> {
  bool _busy = false;

  DateTime get _today => widget.today ?? DateTime.now();

  Future<void> _add() async {
    final today = _today;
    // Opens on today in year view: no adult date is suggested.
    final picked = await showDatePicker(
      context: context,
      initialDate: today,
      firstDate: DateTime(today.year - 120),
      lastDate: today,
      initialDatePickerMode: DatePickerMode.year,
      helpText: 'Your date of birth',
    );
    if (picked == null || !mounted) return;
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Save date of birth?'),
        content: Text(
          '${DateFormat('d MMMM y').format(picked)}\n\n'
          'It can’t be changed later.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            key: const Key('birthday-confirm'),
            onPressed: () => Navigator.pop(ctx, true),
            child: const Text('Save'),
          ),
        ],
      ),
    );
    if (ok != true || !mounted) return;
    setState(() => _busy = true);
    try {
      final updated = await ref.read(accountRepo).setBirthday(picked);
      ref.read(sessionProvider.notifier).replace(updated);
    } catch (e) {
      if (mounted) showError(context, e);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final birthday = ref.watch(sessionProvider).value?.birthday;
    if (birthday != null) {
      return ListTile(
        key: const Key('profile-birthday'),
        contentPadding: EdgeInsets.zero,
        leading: const Icon(Icons.cake_outlined),
        title: Text(DateFormat('d MMMM y').format(birthday.toUtc())),
        subtitle: const Text('Date of birth · can’t be changed'),
        trailing: const Icon(
          Icons.lock_outline,
          size: 18,
          color: BBColors.inkSubtle,
        ),
      );
    }
    return ListTile(
      key: const Key('profile-birthday'),
      contentPadding: EdgeInsets.zero,
      leading: const Icon(Icons.cake_outlined),
      title: const Text('Add your date of birth'),
      subtitle: const Text(
        'Needed for games and withdrawals. Never shown on your profile.',
      ),
      trailing: _busy
          ? const SizedBox.square(
              dimension: 20,
              child: CircularProgressIndicator(strokeWidth: 2),
            )
          : const Icon(Icons.chevron_right),
      onTap: _busy ? null : _add,
    );
  }
}
