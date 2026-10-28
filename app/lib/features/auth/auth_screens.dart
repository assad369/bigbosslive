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
          color: BBColors.bronzeShadow,
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
        try {
          await FirebaseAuth.instance.signInWithCredential(credential);
          if (!sent.isCompleted) sent.complete();
        } catch (e) {
          // Otherwise `sent` never completes and the buttons stay disabled.
          if (!sent.isCompleted) sent.completeError(e);
        }
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
                  color: BBColors.dangerTint,
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
  late String _verificationId = widget.args.verificationId;
  late int? _resendToken = widget.args.resendToken;
  bool _busy = false;
  bool _resending = false;
  DateTime _resendAt = DateTime.now().add(const Duration(seconds: 30));
  Timer? _tick;

  @override
  void initState() {
    super.initState();
    _tick = Timer.periodic(const Duration(seconds: 1), (_) {
      if (mounted) setState(() {});
    });
  }

  @override
  void dispose() {
    _tick?.cancel();
    _code.dispose();
    super.dispose();
  }

  Future<void> _verify() async {
    // Typing the sixth digit and tapping Verify must not submit twice.
    if (_busy || _code.text.trim().length < 6) return;
    setState(() => _busy = true);
    try {
      await FirebaseAuth.instance.signInWithCredential(
        PhoneAuthProvider.credential(
          verificationId: _verificationId,
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
    } catch (e) {
      if (mounted) showError(context, e);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _resend() async {
    setState(() => _resending = true);
    final done = Completer<void>();
    try {
      await FirebaseAuth.instance.verifyPhoneNumber(
        phoneNumber: widget.args.phone,
        forceResendingToken: _resendToken,
        timeout: const Duration(seconds: 60),
        verificationCompleted: (credential) async {
          try {
            await FirebaseAuth.instance.signInWithCredential(credential);
            if (!done.isCompleted) done.complete();
          } catch (e) {
            if (!done.isCompleted) done.completeError(e);
          }
        },
        verificationFailed: (e) {
          if (!done.isCompleted) done.completeError(e);
        },
        codeSent: (verificationId, resendToken) {
          _verificationId = verificationId;
          _resendToken = resendToken;
          if (!done.isCompleted) done.complete();
        },
        codeAutoRetrievalTimeout: (_) {},
      );
      await done.future;
      _resendAt = DateTime.now().add(const Duration(seconds: 30));
      if (mounted) showMessage(context, 'A new code is on its way');
    } on FirebaseAuthException catch (e) {
      if (mounted) showError(context, e.message ?? 'Could not resend the code');
    } catch (e) {
      if (mounted) showError(context, e);
    } finally {
      if (mounted) setState(() => _resending = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final wait = _resendAt.difference(DateTime.now()).inSeconds;
    return Scaffold(
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
            autofillHints: const [AutofillHints.oneTimeCode],
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
          const SizedBox(height: 8),
          Center(
            child: TextButton(
              onPressed: _busy || _resending || wait > 0 ? null : _resend,
              child: Text(wait > 0 ? 'Resend code in ${wait}s' : 'Resend code'),
            ),
          ),
        ],
      ),
    );
  }
}

/// The account is fine but the server couldn't be reached (or failed) while starting the
/// session. Firebase is still signed in, so this retries instead of asking to sign in again.
class OfflineScreen extends ConsumerWidget {
  const OfflineScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final session = ref.watch(sessionProvider);
    final err = session.error;
    return Scaffold(
      body: _ChampagneBackground(
        child: SafeArea(
          child: EmptyState(
            icon: Icons.wifi_off_rounded,
            title: err is ApiException && !err.isNetwork
                ? 'Something went wrong'
                : 'You\'re offline',
            message: err is ApiException && !err.isNetwork
                ? err.message
                : 'Check your internet connection and try again.',
            action: session.isLoading
                ? const SizedBox(
                    width: 24,
                    height: 24,
                    child: CircularProgressIndicator(strokeWidth: 2.4),
                  )
                : Column(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      FilledButton(
                        onPressed: () => ref.invalidate(sessionProvider),
                        child: const Text('Try again'),
                      ),
                      TextButton(
                        onPressed: () =>
                            ref.read(sessionProvider.notifier).signOut(),
                        child: const Text('Sign out'),
                      ),
                    ],
                  ),
          ),
        ),
      ),
    );
  }
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

  /// The store listing, or null on iOS when the build has no `IOS_APP_STORE_ID`.
  static Uri? get storeUri {
    if (Platform.isIOS) {
      return Env.iosAppStoreId.isEmpty
          ? null
          : Uri.parse('https://apps.apple.com/app/id${Env.iosAppStoreId}');
    }
    return Uri.parse(
      'https://play.google.com/store/apps/details?id=${Env.androidPackage}',
    );
  }

  @override
  Widget build(BuildContext context) {
    final uri = storeUri;
    return Scaffold(
      body: EmptyState(
        icon: Icons.system_update_rounded,
        title: 'Update required',
        message: uri == null
            ? 'A new version of BigBoss Live is available. Update it from the App Store to continue.'
            : 'A new version of BigBoss Live is available with important improvements.',
        action: uri == null
            ? null
            : FilledButton(
                onPressed: () =>
                    launchUrl(uri, mode: LaunchMode.externalApplication),
                child: const Text('Update now'),
              ),
      ),
    );
  }
}
