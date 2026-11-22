import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../core/config/env.dart';
import '../../core/config/legal.dart';
import '../../core/network/api_exception.dart';
import '../../core/providers.dart';
import '../../core/theme/bb_colors.dart';
import '../../core/widgets/widgets.dart';
import 'delete_account.dart';

/// Before anything else: acceptance of the current Terms, Community Guidelines and Privacy
/// Policy. The router sends every signed-in user with `needsConsent` here, existing accounts
/// included. The date of birth is given from Edit profile instead.
class ConsentScreen extends ConsumerStatefulWidget {
  const ConsentScreen({super.key});

  @override
  ConsumerState<ConsentScreen> createState() => _ConsentScreenState();
}

class _ConsentScreenState extends ConsumerState<ConsentScreen> {
  bool _agreed = false;
  bool _busy = false;

  Future<void> _submit() async {
    if (_busy || !_agreed) return;
    setState(() => _busy = true);
    try {
      final updated = await ref.read(accountRepo).consent();
      ref.read(sessionProvider.notifier).replace(updated);
    } on ApiException catch (e) {
      if (e.code == 'underage') {
        ref.read(sessionProvider.notifier).refuse(e);
      } else if (mounted) {
        showError(context, e);
      }
    } catch (e) {
      if (mounted) showError(context, e);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final cfg = ref.watch(appConfigProvider).value;
    final ready = _agreed;
    const link = TextStyle(
      color: BBColors.bronze,
      fontWeight: FontWeight.w700,
      decoration: TextDecoration.underline,
      decorationColor: BBColors.bronze,
    );
    TapGestureRecognizer open(String url) =>
        TapGestureRecognizer()
          ..onTap = () =>
              launchUrl(Uri.parse(url), mode: LaunchMode.inAppBrowserView);

    return Scaffold(
      appBar: AppBar(
        title: const Text('Before you start'),
        automaticallyImplyLeading: false,
        actions: [
          TextButton(
            onPressed: () => ref.read(sessionProvider.notifier).signOut(),
            child: const Text('Sign out'),
          ),
        ],
      ),
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.fromLTRB(20, 8, 20, 24),
          children: [
            Text(
              'BigBoss Live is for adults only ($kMinUserAge+).',
              style: Theme.of(context).textTheme.titleMedium,
            ),
            const SizedBox(height: 8),
            const Text(
              'Please read and accept our rules before you continue.',
              style: TextStyle(color: BBColors.inkMuted),
            ),
            const SizedBox(height: 20),
            CheckboxListTile(
              key: const Key('consent-agree'),
              value: _agreed,
              onChanged: _busy
                  ? null
                  : (v) => setState(() => _agreed = v ?? false),
              controlAffinity: ListTileControlAffinity.leading,
              contentPadding: EdgeInsets.zero,
              title: Text.rich(
                TextSpan(
                  children: [
                    const TextSpan(
                      text: 'I am $kMinUserAge or older and I agree to the ',
                    ),
                    TextSpan(
                      text: 'Terms of Service',
                      style: link,
                      recognizer: open(cfg?.termsUrl ?? Env.termsUrl),
                    ),
                    const TextSpan(text: ', the '),
                    TextSpan(
                      text: 'Community Guidelines',
                      style: link,
                      recognizer: open(
                        cfg?.communityGuidelinesUrl ??
                            Env.communityGuidelinesUrl,
                      ),
                    ),
                    const TextSpan(text: ' and the '),
                    TextSpan(
                      text: 'Privacy Policy',
                      style: link,
                      recognizer: open(cfg?.privacyUrl ?? Env.privacyUrl),
                    ),
                    const TextSpan(text: '.'),
                  ],
                ),
              ),
            ),
            const SizedBox(height: 8),
            const Text(
              'There is no tolerance for objectionable content or abusive behaviour. '
              'Content that breaks the rules is removed, and accounts that break them are '
              'banned. Report and block anyone from their profile, a live, a message or a '
              'post.',
              style: TextStyle(color: BBColors.inkSubtle, fontSize: 12),
            ),
            const SizedBox(height: 24),
            FilledButton(
              key: const Key('consent-continue'),
              onPressed: ready && !_busy ? _submit : null,
              child: _busy
                  ? const SizedBox.square(
                      dimension: 20,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : const Text('Continue'),
            ),
          ],
        ),
      ),
    );
  }
}

/// The account gave an under-18 date of birth: it can't be used, only deleted.
class UnderageScreen extends ConsumerWidget {
  const UnderageScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) => Scaffold(
    body: EmptyState(
      icon: Icons.no_accounts_outlined,
      title: 'BigBoss Live is for adults',
      message:
          'You must be $kMinUserAge or older to use BigBoss Live, so this account is locked. '
          'You can delete it, or sign out.',
      action: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          FilledButton(
            style: FilledButton.styleFrom(backgroundColor: BBColors.danger),
            onPressed: () => confirmDeleteAccount(context, ref),
            child: const Text('Delete account'),
          ),
          TextButton(
            onPressed: () => ref.read(sessionProvider.notifier).signOut(),
            child: const Text('Sign out'),
          ),
        ],
      ),
    ),
  );
}
