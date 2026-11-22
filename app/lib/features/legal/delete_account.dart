import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../core/config/env.dart';
import '../../core/providers.dart';
import '../../core/theme/bb_colors.dart';
import '../../core/widgets/widgets.dart';

/// What deleting removes and keeps. It matches the server (`UsersService.deleteAccount`) and
/// the privacy policy, so the promise is one the backend keeps.
const deleteAccountExplanation =
    'This permanently deletes your profile, followers, posts, comments and likes, the text '
    'and photos of messages you sent, your uploads and your sign-in.\n\n'
    'Diamonds left in your account are lost. We keep purchase, gift, game and withdrawal '
    'records as financial law requires, and safety reports. A withdrawal under review must '
    'finish first.\n\nThis cannot be undone.';

/// Confirms, deletes the account and signs out. Works for banned and underage accounts too,
/// which the server lets delete themselves.
Future<void> confirmDeleteAccount(BuildContext context, WidgetRef ref) async {
  final privacyUrl =
      ref.read(appConfigProvider).value?.privacyUrl ?? Env.privacyUrl;
  final ok = await showDialog<bool>(
    context: context,
    builder: (c) => AlertDialog(
      title: const Text('Delete your account?'),
      content: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text(deleteAccountExplanation),
            TextButton(
              style: TextButton.styleFrom(padding: EdgeInsets.zero),
              onPressed: () => launchUrl(
                Uri.parse(privacyUrl),
                mode: LaunchMode.inAppBrowserView,
              ),
              child: const Text('Privacy policy'),
            ),
          ],
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(c).pop(false),
          child: const Text('Cancel'),
        ),
        FilledButton(
          style: FilledButton.styleFrom(backgroundColor: BBColors.danger),
          onPressed: () => Navigator.of(c).pop(true),
          child: const Text('Delete'),
        ),
      ],
    ),
  );
  if (ok != true) return;
  try {
    await ref.read(accountRepo).deleteAccount();
    await ref.read(sessionProvider.notifier).signOut();
  } catch (e) {
    if (context.mounted) showError(context, e);
  }
}
