import 'dart:async';

import 'package:firebase_auth/firebase_auth.dart';
import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_crashlytics/firebase_crashlytics.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:google_sign_in/google_sign_in.dart';

import 'app.dart';
import 'core/config/env.dart';
import 'core/network/device_id.dart';
import 'core/providers.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await SystemChrome.setPreferredOrientations([DeviceOrientation.portraitUp]);

  // Firebase reads google-services.json / GoogleService-Info.plist (see app/README.md).
  await Firebase.initializeApp();
  final emulator = Env.authEmulator.split(':');
  final emulatorPort = emulator.length == 2 ? int.tryParse(emulator[1]) : null;
  if (emulatorPort != null) {
    await FirebaseAuth.instance.useAuthEmulator(emulator[0], emulatorPort);
  }
  await GoogleSignIn.instance.initialize(
    serverClientId: Env.googleServerClientId.isEmpty
        ? null
        : Env.googleServerClientId,
  );

  // Crash reporting: every uncaught Flutter and platform error, except in debug builds.
  await FirebaseCrashlytics.instance.setCrashlyticsCollectionEnabled(
    !kDebugMode,
  );
  FlutterError.onError = FirebaseCrashlytics.instance.recordFlutterFatalError;
  PlatformDispatcher.instance.onError = (error, stack) {
    unawaited(
      FirebaseCrashlytics.instance.recordError(error, stack, fatal: true),
    );
    return true;
  };

  final deviceId = await DeviceId.load();
  runApp(
    ProviderScope(
      retry: providerRetry,
      overrides: [deviceIdProvider.overrideWithValue(deviceId.value)],
      child: const BigBossApp(),
    ),
  );
}
