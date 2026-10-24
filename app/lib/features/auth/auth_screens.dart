import 'dart:async';
import 'dart:io';

import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:google_sign_in/google_sign_in.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../core/config/env.dart';
import '../../core/network/api_exception.dart';
import '../../core/providers.dart';
import '../../core/theme/bb_colors.dart';
import '../../core/widgets/widgets.dart';

class BrandMark extends StatelessWidget {
  const BrandMark({super.key, this.size = 88});
  final double size;

  @override
  Widget build(BuildContext context) => Container(
    width: size,
    height: size,
    decoration: BoxDecoration(
      color: BBColors.ink,
      borderRadius: BorderRadius.circular(size * 0.24),
      boxShadow: const [
        BoxShadow(
          color: Color(0x406B4826),
          blurRadius: 30,
          offset: Offset(0, 12),
        ),
      ],
    ),
    child: Center(
      child: ShaderMask(
        blendMode: BlendMode.srcIn,
        shaderCallback: (b) =>
            BBColors.goldGradient.createShader(Offset.zero & b.size),
        child: Icon(Icons.workspace_premium_rounded, size: size * 0.6),
      ),
    ),
  );
}

class _ChampagneBackground extends StatelessWidget {
  const _ChampagneBackground({required this.child});
  final Widget child;

  @override
  Widget build(BuildContext context) => DecoratedBox(
    decoration: const BoxDecoration(
      gradient: RadialGradient(
        center: Alignment(-0.8, -1),
        radius: 1.4,
        colors: [BBColors.champagne, BBColors.ivory],
      ),
    ),
    child: child,
  );
}

class SplashScreen extends ConsumerWidget {
  const SplashScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final config = ref.watch(appConfigProvider);
    return Scaffold(
      body: _ChampagneBackground(
        child: Center(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const BrandMark(),
              const SizedBox(height: 20),
              GradientText(
                'BigBoss Live',
                style: Theme.of(context).textTheme.headlineMedium,
              ),
              const SizedBox(height: 28),
              if (config.hasError)
                Column(
                  children: [
                    const Text(
                      'Unable to reach BigBoss Live',
                      style: TextStyle(color: BBColors.inkMuted),
                    ),
                    TextButton(
                      onPressed: () => ref.invalidate(appConfigProvider),
                      child: const Text('Retry'),
                    ),
                  ],
                )
              else
                const SizedBox(
                  width: 24,
                  height: 24,
                  child: CircularProgressIndicator(strokeWidth: 2.4),
                ),
            ],
          ),
        ),
      ),
    );
  }
}

class LoginScreen extends ConsumerStatefulWidget {
  const LoginScreen({super.key});

  @override
  ConsumerState<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends ConsumerState<LoginScreen> {
  bool _busy = false;
  final _phone = TextEditingController(text: '+880');

  @override
  void dispose() {
    _phone.dispose();
    super.dispose();
  }

  Future<void> _run(Future<void> Function() action) async {
    setState(() => _busy = true);
    try {
      await action();
    } on GoogleSignInException catch (e) {
      if (e.code != GoogleSignInExceptionCode.canceled && mounted) {
        showError(context, 'Google sign-in failed');
      }
    } on FirebaseAuthException catch (e) {
      if (mounted) showError(context, e.message ?? 'Sign-in failed');
    } catch (e) {
      if (mounted) showError(context, e);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _google() => _run(() async {
    final account = await GoogleSignIn.instance.authenticate();
    final idToken = account.authentication.idToken;
    if (idToken == null) {
      throw const ApiException(0, 'google', 'Google did not return a token');
    }
    await FirebaseAuth.instance.signInWithCredential(
      GoogleAuthProvider.credential(idToken: idToken),
    );
  });

  Future<void> _apple() => _run(() async {
    await FirebaseAuth.instance.signInWithProvider(
      AppleAuthProvider()
        ..addScope('name')
        ..addScope('email'),
    );
  });

  Future<void> _sendCode() => _run(() async {
    final phone = _phone.text.replaceAll(RegExp(r'[\s-]'), '');
    if (!RegExp(r'^\+\d{8,15}$').hasMatch(phone)) {
      throw const ApiException(
        0,
        'phone',
        'Enter your number with country code, e.g. +8801712345678',
      );
    }
    final sent = Completer<void>();
    await FirebaseAuth.instance.verifyPhoneNumber(
      phoneNumber: phone,
      timeout: const Duration(seconds: 60),
      // Android can auto-retrieve the SMS and sign in without the code screen.
      verificationCompleted: (credential) async {
        await FirebaseAuth.instance.signInWithCredential(credential);
        if (!sent.isCompleted) sent.complete();
      },
      verificationFailed: (e) {
        if (!sent.isCompleted) sent.completeError(e);
      },
      codeSent: (verificationId, resendToken) {
        if (!sent.isCompleted) sent.complete();
        if (mounted) {
          unawaited(
            context.push(
              '/otp',
              extra: OtpArgs(
                phone: phone,
                verificationId: verificationId,
                resendToken: resendToken,
              ),
            ),
          );
        }
      },
      codeAutoRetrievalTimeout: (_) {},
    );
    await sent.future;
  });

  @override
  Widget build(BuildContext context) {
    final session = ref.watch(sessionProvider);
    final text = Theme.of(context).textTheme;
    return Scaffold(
      body: _ChampagneBackground(
        child: SafeArea(
          child: ListView(
            padding: const EdgeInsets.fromLTRB(24, 48, 24, 24),
            children: [
              const Center(child: BrandMark(size: 76)),
              const SizedBox(height: 20),
              Center(
                child: GradientText('BigBoss Live', style: text.headlineLarge),
              ),
              const SizedBox(height: 6),
              const Center(
                child: Text(
                  'Go live. Shine gold.',
                  style: TextStyle(color: BBColors.inkMuted, fontSize: 15),
                ),
              ),
              const SizedBox(height: 40),
              if (session.hasError) ...[
                Card(
                  color: const Color(0xFFFBEAE8),
                  child: Padding(
                    padding: const EdgeInsets.all(12),
                    child: Text(
                      session.error.toString(),
                      style: const TextStyle(color: BBColors.danger),
                    ),
                  ),
                ),
                const SizedBox(height: 16),
              ],
              GoldButton(
                label: 'Continue with Google',
                icon: Icons.g_mobiledata_rounded,
                loading: _busy,
                onPressed: _google,
              ),
              if (Platform.isIOS) ...[
                const SizedBox(height: 12),
                OutlinedButton.icon(
                  onPressed: _busy ? null : _apple,
                  icon: const Icon(Icons.apple),
                  label: const Text('Continue with Apple'),
                ),
              ],
              const SizedBox(height: 28),
              const Row(
                children: [
                  Expanded(child: Divider()),
                  Padding(
                    padding: EdgeInsets.symmetric(horizontal: 12),
                    child: Text(
                      'or use your phone',
                      style: TextStyle(color: BBColors.inkSubtle),
                    ),
                  ),
                  Expanded(child: Divider()),
                ],
              ),
              const SizedBox(height: 20),
              TextField(
                controller: _phone,
                keyboardType: TextInputType.phone,
                decoration: const InputDecoration(
                  prefixIcon: Icon(Icons.phone_iphone_rounded),
                  hintText: '+8801712345678',
                ),
              ),
              const SizedBox(height: 12),
              FilledButton(
                onPressed: _busy ? null : _sendCode,
                child: const Text('Send code'),
              ),
              const SizedBox(height: 32),
              const Text.rich(
                TextSpan(
                  style: TextStyle(color: BBColors.inkSubtle, fontSize: 12),
                  children: [
                    TextSpan(text: 'By continuing you agree to our '),
                    WidgetSpan(child: _Link('Terms', Env.termsUrl)),
                    TextSpan(text: ' and '),
                    WidgetSpan(child: _Link('Privacy Policy', Env.privacyUrl)),
                    TextSpan(text: '. You must be 18 or older.'),
                  ],
                ),
                textAlign: TextAlign.center,
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _Link extends StatelessWidget {
  const _Link(this.label, this.url);
  final String label;
  final String url;

  @override
  Widget build(BuildContext context) => GestureDetector(
    onTap: () => launchUrl(Uri.parse(url), mode: LaunchMode.inAppBrowserView),
    child: Text(
      label,
      style: const TextStyle(
        color: BBColors.bronze,
        fontSize: 12,
        fontWeight: FontWeight.w700,
      ),
    ),
  );
}

class OtpArgs {
  const OtpArgs({
    required this.phone,
    required this.verificationId,
    this.resendToken,
  });
  final String phone;
  final String verificationId;
  final int? resendToken;
}

class OtpScreen extends StatefulWidget {
  const OtpScreen({super.key, required this.args});
  final OtpArgs args;

  @override
  State<OtpScreen> createState() => _OtpScreenState();
}

class _OtpScreenState extends State<OtpScreen> {
  final _code = TextEditingController();
  bool _busy = false;

  @override
  void dispose() {
    _code.dispose();
    super.dispose();
  }

  Future<void> _verify() async {
    if (_code.text.trim().length < 6) return;
    setState(() => _busy = true);
    try {
      await FirebaseAuth.instance.signInWithCredential(
        PhoneAuthProvider.credential(
          verificationId: widget.args.verificationId,
          smsCode: _code.text.trim(),
        ),
      );
    } on FirebaseAuthException catch (e) {
      if (mounted) {
        showError(
          context,
          e.code == 'invalid-verification-code'
              ? 'That code is not right'
              : (e.message ?? 'Verification failed'),
        );
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(),
    body: ListView(
      padding: const EdgeInsets.all(24),
      children: [
        Text(
          'Enter the code',
          style: Theme.of(context).textTheme.headlineSmall,
        ),
        const SizedBox(height: 8),
        Text(
          'We sent a 6-digit code to ${widget.args.phone}',
          style: const TextStyle(color: BBColors.inkMuted),
        ),
        const SizedBox(height: 24),
        TextField(
          controller: _code,
          autofocus: true,
          keyboardType: TextInputType.number,
          maxLength: 6,
          textAlign: TextAlign.center,
          style: const TextStyle(
            fontSize: 28,
            letterSpacing: 12,
            fontWeight: FontWeight.w700,
          ),
          onChanged: (v) {
            if (v.length == 6) unawaited(_verify());
          },
          decoration: const InputDecoration(counterText: ''),
        ),
        const SizedBox(height: 16),
        GoldButton(label: 'Verify', loading: _busy, onPressed: _verify),
      ],
    ),
  );
}

class BannedScreen extends ConsumerWidget {
  const BannedScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final err = ref.watch(sessionProvider).error;
    final details = err is ApiException && err.details is Map<String, dynamic>
        ? err.details! as Map<String, dynamic>
        : const <String, dynamic>{};
    final until = details['until'] is String
        ? DateTime.tryParse(details['until'] as String)
        : null;
    return Scaffold(
      body: EmptyState(
        icon: Icons.block_rounded,
        title: err is ApiException && err.code == 'device_banned'
            ? 'This device is banned'
            : 'Your account is suspended',
        message: [
          if (details['reason'] is String) 'Reason: ${details['reason']}',
          if (until != null)
            'Until ${until.toLocal()}'
          else
            'Contact support if you believe this is a mistake.',
        ].join('\n'),
        action: TextButton(
          onPressed: () => ref.read(sessionProvider.notifier).signOut(),
          child: const Text('Sign out'),
        ),
      ),
    );
  }
}

class MaintenanceScreen extends ConsumerWidget {
  const MaintenanceScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final cfg = ref.watch(appConfigProvider).value;
    return Scaffold(
      body: EmptyState(
        icon: Icons.construction_rounded,
        title: 'We are polishing the gold',
        message: (cfg?.maintenanceMessage.isNotEmpty ?? false)
            ? cfg!.maintenanceMessage
            : 'BigBoss Live is under maintenance. Please check back shortly.',
        action: OutlinedButton(
          onPressed: () => ref.invalidate(appConfigProvider),
          child: const Text('Check again'),
        ),
      ),
    );
  }
}

class ForceUpdateScreen extends StatelessWidget {
  const ForceUpdateScreen({super.key});

  @override
  Widget build(BuildContext context) => Scaffold(
    body: EmptyState(
      icon: Icons.system_update_rounded,
      title: 'Update required',
      message: 'A new version of BigBoss Live is available with important improvements.',
      action: FilledButton(
        onPressed: () => launchUrl(
          Uri.parse(
            Platform.isIOS ? 'https://apps.apple.com/app/bigboss-live' : 'https://play.google.com/store/apps/details?id=com.bigbosslive.bigboss_live',
          ),
          mode: LaunchMode.externalApplication,
        ),
        child: const Text('Update now'),
      ),
    ),
  );
}
