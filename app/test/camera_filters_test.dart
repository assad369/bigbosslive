import 'dart:convert';

import 'package:bigboss_live/core/providers.dart';
import 'package:bigboss_live/data/repositories.dart';
import 'package:bigboss_live/features/live/camera_filter_channel.dart';
import 'package:bigboss_live/features/live/camera_filters.dart';
import 'package:bigboss_live/features/live/filter_picker.dart';
import 'package:bigboss_live/features/live/live_room_controller.dart';
import 'package:bigboss_live/models/models.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

class _FakeRepo implements LiveRepository {
  @override
  dynamic noSuchMethod(Invocation invocation) =>
      throw UnimplementedError('${invocation.memberName}');
}

final _me = MeUser.fromJson({
  'id': 'u1',
  'shortId': '201',
  'displayName': 'Boss',
  'wallet': {'diamonds': 1},
  'levelProgress': {'level': 1},
});

void _expectMatrix(ColorMatrix actual, ColorMatrix expected) {
  for (var i = 0; i < 20; i++) {
    expect(actual.values[i], closeTo(expected.values[i], 1e-9), reason: '$i');
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    SharedPreferences.setMockInitialValues({});
    CameraFilterPrefs.resetCache();
  });

  group('catalogue', () {
    test('None first, then Whitening & Beautify, which is the default', () {
      expect(CameraFilters.all.first.id, 'none');
      expect(CameraFilters.all[1], same(CameraFilters.beauty));
      expect(CameraFilters.beauty.name, 'Whitening & Beautify');
      expect(CameraFilters.defaultFilter, same(CameraFilters.beauty));
      expect(CameraFilters.all, hasLength(36));
    });

    test('ids are unique and unknown ids fall back to the default', () {
      final ids = CameraFilters.all.map((f) => f.id).toSet();
      expect(ids, hasLength(CameraFilters.all.length));
      expect(
        CameraFilters.byId('removed_in_future'),
        same(CameraFilters.defaultFilter),
      );
      expect(CameraFilters.byId(null), same(CameraFilters.defaultFilter));
      expect(CameraFilters.byId('none').isNone, isTrue);
      expect(CameraFilters.byId('none').hasBeauty, isFalse);
    });

    test('only beauty carries beauty params; every look is well formed', () {
      for (final f in CameraFilters.all) {
        expect(f.hasBeauty, f.id == 'beauty', reason: f.id);
        expect(f.matrix.values, hasLength(20), reason: f.id);
        expect(f.matrix.values.every((v) => v.isFinite), isTrue, reason: f.id);
        expect(f.vignette, inInclusiveRange(0, 1), reason: f.id);
        expect(f.name.trim(), isNotEmpty, reason: f.id);
      }
      expect(CameraFilters.beauty.beauty, BeautyParams.preset);
    });
  });

  group('ColorMatrix', () {
    test('identity is neutral under composition', () {
      final look = CameraFilters.byId('clarendon').matrix;
      _expectMatrix(ColorMatrix.identity.then(look), look);
      _expectMatrix(look.then(ColorMatrix.identity), look);
      _expectMatrix(ColorMatrix.chain(const []), ColorMatrix.identity);
    });

    test('neutral amounts are the identity', () {
      _expectMatrix(ColorMatrix.contrast(1), ColorMatrix.identity);
      _expectMatrix(ColorMatrix.saturate(1), ColorMatrix.identity);
      _expectMatrix(ColorMatrix.brightness(1), ColorMatrix.identity);
      _expectMatrix(ColorMatrix.hueRotate(0), ColorMatrix.identity);
      _expectMatrix(ColorMatrix.sepia(0), ColorMatrix.identity);
    });

    test('then applies this first', () {
      // Brightness 2 then a +10 offset: 2x + 10, not 2(x + 10).
      final m = ColorMatrix.brightness(
        2,
      ).then(ColorMatrix.rgb(const [1, 0, 0, 0, 1, 0, 0, 0, 1], [10, 10, 10]));
      expect(m.values[0], 2);
      expect(m.values[4], 10);
    });
  });

  group('BeautyParams', () {
    test('fromMap clamps, and junk takes the preset value', () {
      final b = BeautyParams.fromMap({
        'smoothing': 3,
        'whitening': -1,
        'redness': 'x',
      });
      expect(b.smoothing, 1);
      expect(b.whitening, 0);
      expect(b.redness, BeautyParams.preset.redness);
      expect(
        BeautyParams.fromMap({'smoothing': double.nan}).smoothing,
        BeautyParams.preset.smoothing,
      );
    });

    test('toMap round-trips and copyWith clamps', () {
      const b = BeautyParams(smoothing: 0.2, whitening: 0.4, redness: 0.6);
      expect(BeautyParams.fromMap(b.toMap()), b);
      expect(b.copyWith(redness: 2).redness, 1);
      expect(b.copyWith(smoothing: double.infinity).smoothing, 0);
      expect(
        const BeautyParams(smoothing: 0, whitening: 0, redness: 0).isOff,
        isTrue,
      );
    });
  });

  group('CameraFilterPrefs', () {
    test('nothing saved: beauty with the preset', () async {
      final saved = await CameraFilterPrefs.load();
      expect(saved.filterId, CameraFilters.defaultFilter.id);
      expect(saved.beauty, BeautyParams.preset);
    });

    test('an explicit None and adjusted beauty are kept on disk', () async {
      await CameraFilterPrefs.saveFilter('none');
      await CameraFilterPrefs.saveBeauty(
        const BeautyParams(smoothing: 0.1, whitening: 0.2, redness: 0.3),
      );
      CameraFilterPrefs.resetCache();
      final saved = await CameraFilterPrefs.load();
      expect(saved.filterId, 'none');
      expect(
        saved.beauty,
        const BeautyParams(smoothing: 0.1, whitening: 0.2, redness: 0.3),
      );
    });

    test('corrupt or removed values fall back', () async {
      SharedPreferences.setMockInitialValues({
        'bb.camera_filter': 'removed_look',
        'bb.camera_beauty': '{not json',
      });
      final saved = await CameraFilterPrefs.load();
      expect(saved.filterId, CameraFilters.defaultFilter.id);
      expect(saved.beauty, BeautyParams.preset);
    });

    test('a saved choice is readable at once, before the disk write', () async {
      final write = CameraFilterPrefs.saveFilter('juno');
      expect((await CameraFilterPrefs.load()).filterId, 'juno');
      await write;
      final prefs = await SharedPreferences.getInstance();
      expect(prefs.getString('bb.camera_filter'), 'juno');
      expect(jsonDecode(prefs.getString('bb.camera_beauty') ?? 'null'), isNull);
    });
  });

  group('CameraFilterChannel', () {
    final calls = <MethodCall>[];
    final messenger =
        TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;

    setUp(() {
      calls.clear();
      messenger.setMockMethodCallHandler(CameraFilterChannel.channel, (call) {
        calls.add(call);
        return null;
      });
    });
    tearDown(() {
      messenger.setMockMethodCallHandler(CameraFilterChannel.channel, null);
      debugDefaultTargetPlatformOverride = null;
    });

    test('no track, no call', () async {
      await CameraFilterChannel.apply(null, CameraFilters.beauty);
      await CameraFilterChannel.clear(null);
      expect(calls, isEmpty);
    });

    test('beauty sends the user sliders with an identity matrix', () async {
      const mine = BeautyParams(smoothing: 0.9, whitening: 0.1, redness: 0);
      await CameraFilterChannel.applyToTrackId(
        't1',
        CameraFilters.beauty,
        beauty: mine,
      );
      final call = calls.single;
      expect(call.method, 'apply');
      final args = call.arguments as Map<Object?, Object?>;
      expect(args['trackId'], 't1');
      expect(args['matrix'], isA<Float64List>());
      expect(args['matrix'], ColorMatrix.identity.values);
      expect(args['vignette'], 0);
      expect(args['beauty'], mine.toMap());
    });

    test('a colour look sends no beauty, even with sliders set', () async {
      final look = CameraFilters.byId('xpro2');
      await CameraFilterChannel.applyToTrackId(
        't1',
        look,
        beauty: BeautyParams.preset,
      );
      final args = calls.single.arguments as Map<Object?, Object?>;
      expect(args['beauty'], isNull);
      expect(args['vignette'], look.vignette);
      expect(args['matrix'], look.matrix.values);
    });

    test('None detaches', () async {
      await CameraFilterChannel.applyToTrackId('t1', CameraFilters.none);
      expect(calls.single.method, 'clear');
      expect(calls.single.arguments, {'trackId': 't1'});
    });

    test('native errors never escape', () async {
      messenger.setMockMethodCallHandler(
        CameraFilterChannel.channel,
        (_) => throw PlatformException(code: 'NO_TRACK'),
      );
      await CameraFilterChannel.applyToTrackId('t1', CameraFilters.beauty);
      messenger.setMockMethodCallHandler(CameraFilterChannel.channel, null);
      await CameraFilterChannel.clearTrackId('t1'); // no plugin registered
    });

    test('unsupported platforms send nothing', () async {
      debugDefaultTargetPlatformOverride = TargetPlatform.macOS;
      expect(CameraFilterChannel.isSupported, isFalse);
      await CameraFilterChannel.applyToTrackId('t1', CameraFilters.beauty);
      expect(calls, isEmpty);
    });
  });

  group('controller', () {
    test('setFilter and setBeauty update, notify and persist', () async {
      final c = LiveRoomController(
        roomId: 'r1',
        myUid: 'u1',
        repo: _FakeRepo(),
      );
      addTearDown(c.dispose);
      var notified = 0;
      c.addListener(() => notified++);

      await c.setFilter('lofi');
      expect(c.filterId, 'lofi');
      expect(notified, 1);

      await c.setFilter('gone');
      expect(c.filterId, CameraFilters.defaultFilter.id);

      const b = BeautyParams(smoothing: 0.3, whitening: 0.3, redness: 0.3);
      await c.setBeauty(b, persist: false);
      expect(c.beauty, b);
      CameraFilterPrefs.resetCache();
      expect((await CameraFilterPrefs.load()).beauty, BeautyParams.preset);

      await c.setBeauty(b);
      CameraFilterPrefs.resetCache();
      final saved = await CameraFilterPrefs.load();
      expect(saved.beauty, b);
      expect(saved.filterId, CameraFilters.defaultFilter.id);
    });
  });

  group('sheet', () {
    Widget wrap(Widget child) => ProviderScope(
      overrides: [meProvider.overrideWithValue(_me)],
      child: MaterialApp(home: Scaffold(body: child)),
    );

    testWidgets('sliders show only for beauty; picking a look hides them', (
      tester,
    ) async {
      final picked = <String>[];
      await tester.pumpWidget(
        wrap(
          CameraFilterSheet(
            filterId: 'beauty',
            beauty: BeautyParams.preset,
            onFilter: (f) => picked.add(f.id),
            onBeauty: (_, {required persist}) {},
          ),
        ),
      );
      expect(find.text('Smooth'), findsOneWidget);
      expect(find.text('60'), findsOneWidget);

      await tester.tap(find.bySemanticsLabel('Clarendon filter'));
      await tester.pumpAndSettle();
      expect(picked, ['clarendon']);
      expect(find.text('Smooth'), findsNothing);
    });

    testWidgets('dragging streams then saves; Reset restores the preset', (
      tester,
    ) async {
      final changes = <(BeautyParams, bool)>[];
      await tester.pumpWidget(
        wrap(
          CameraFilterSheet(
            filterId: 'beauty',
            beauty: BeautyParams.preset,
            onFilter: (_) {},
            onBeauty: (b, {required persist}) => changes.add((b, persist)),
          ),
        ),
      );
      final reset = find.widgetWithText(TextButton, 'Reset');
      expect(tester.widget<TextButton>(reset).onPressed, isNull);

      await tester.drag(find.byType(Slider).first, const Offset(-150, 0));
      await tester.pumpAndSettle();
      expect(changes.first.$2, isFalse); // streamed while dragging
      expect(changes.last.$2, isTrue); // saved on release
      expect(changes.last.$1.smoothing, lessThan(0.6));
      expect(changes.last.$1.whitening, BeautyParams.preset.whitening);

      await tester.tap(reset);
      await tester.pumpAndSettle();
      expect(changes.last, (BeautyParams.preset, true));
      expect(tester.widget<TextButton>(reset).onPressed, isNull);
    });
  });
}
