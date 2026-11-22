import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:intl/intl.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../core/config/env.dart';
import '../../core/config/legal.dart';
import '../../core/network/api_exception.dart';
import '../../core/providers.dart';
import '../../core/theme/bb_colors.dart';
import '../../core/widgets/widgets.dart';
import 'delete_account.dart';

/// Before anything else: a date of birth (given once, an under-18 date locks the account) and
/// acceptance of the current Terms, Community Guidelines and Privacy Policy. The router sends
/// every signed-in user with `needsConsent` here, existing accounts included.
class ConsentScreen extends ConsumerStatefulWidget {
  const ConsentScreen({super.key, this.today});

  /// Fixed in tests; otherwise the device date.
  final DateTime? today;

  @override
  ConsumerState<ConsentScreen> createState() => _ConsentScreenState();
}

class _ConsentScreenState extends ConsumerState<ConsentScreen> {
  DateTime? _birthday;
  bool _agreed = false;
  bool _busy = false;

  DateTime get _today => widget.today ?? DateTime.now();

  Future<void> _pickBirthday() async {
    final today = _today;
    // Opens on today in year view: no adult date is suggested.
    final picked = await showDatePicker(
      context: context,
      initialDate: _birthday ?? today,
      firstDate: DateTime(today.year - 120),
      lastDate: today,
      initialDatePickerMode: DatePickerMode.year,
      helpText: 'Your date of birth',
    );
    if (picked != null) setState(() => _birthday = picked);
  }

  Future<void> _submit() async {
    final me = ref.read(sessionProvider).value;
    final needsBirthday = me?.birthday == null;
    if (_busy || !_agreed || (needsBirthday && _birthday == null)) return;
    setState(() => _busy = true);
    try {
      final updated = await ref
          .read(accountRepo)
          .consent(birthday: needsBirthday ? _birthday : null);
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
    final me = ref.watch(sessionProvider).value;
    final cfg = ref.watch(appConfigProvider).value;
    final needsBirthday = me?.birthday == null;
    final ready = _agreed && (!needsBirthday || _birthday != null);
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
              'We need your date of birth to confirm your age. It is never shown on your '
              'profile, and it can’t be changed later.',
              style: TextStyle(color: BBColors.inkMuted),
            ),
            const SizedBox(height: 20),
            if (needsBirthday)
              OutlinedButton.icon(
                key: const Key('consent-birthday'),
                onPressed: _busy ? null : _pickBirthday,
                icon: const Icon(Icons.cake_outlined),
                label: Text(
                  _birthday == null
                      ? 'Select your date of birth'
                      : DateFormat('d MMMM y').format(_birthday!),
                ),
              )
            else
              ListTile(
                contentPadding: EdgeInsets.zero,
                leading: const Icon(Icons.cake_outlined),
                title: Text(
                  DateFormat('d MMMM y').format(me!.birthday!.toUtc()),
                ),
                subtitle: const Text('Date of birth'),
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
