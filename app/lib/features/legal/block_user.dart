import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/providers.dart';
import '../../core/widgets/widgets.dart';

/// Block someone from wherever their content is (a live, a message, a post). Asks first and
/// says what blocking does. Returns true once blocked.
Future<bool> confirmBlock(
  BuildContext context,
  WidgetRef ref, {
  required String uid,
  required String name,
}) async {
  final ok = await showDialog<bool>(
    context: context,
    builder: (c) => AlertDialog(
      title: Text('Block $name?'),
      content: const Text(
        'They won’t be able to message you, follow you, comment on your posts or join your '
        'lives. You can unblock them in Settings → Blocked users.',
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(c).pop(false),
          child: const Text('Cancel'),
        ),
        FilledButton(
          onPressed: () => Navigator.of(c).pop(true),
          child: const Text('Block'),
        ),
      ],
    ),
  );
  if (ok != true) return false;
  try {
    await ref.read(accountRepo).block(uid, true);
    if (context.mounted) showMessage(context, '$name is blocked');
    return true;
  } catch (e) {
    if (context.mounted) showError(context, e);
    return false;
  }
}
