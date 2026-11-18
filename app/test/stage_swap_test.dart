import 'package:bigboss_live/core/theme/bb_colors.dart';
import 'package:bigboss_live/core/utils/format.dart';
import 'package:bigboss_live/data/repositories.dart';
import 'package:bigboss_live/features/live/live_room_controller.dart';
import 'package:bigboss_live/features/live/live_stage.dart';
import 'package:bigboss_live/features/live/speaking_indicator.dart';
import 'package:bigboss_live/models/models.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

class _FakeRepo implements LiveRepository {
  @override
  dynamic noSuchMethod(Invocation invocation) =>
      throw UnimplementedError('${invocation.memberName}');
}

Map<String, dynamic> _seat(
  int index,
  String? uid, {
  int diamonds = 0,
  bool videoMuted = false,
}) => {
  'index': index,
  'userId': uid,
  'muted': false,
  'videoMuted': videoMuted,
  'locked': false,
  'user': uid == null ? null : {'id': uid, 'displayName': 'User $uid'},
  'diamonds': diamonds,
  // Tiles show today's gifts; the fixtures keep them equal to the balance.
  'todayDiamonds': diamonds,
};

LiveRoomController _controller({
  required String me,
  List<String> mods = const [],
  String? swapped,
  String type = 'video',
  bool guest = true,
  bool guestVideoMuted = false,
}) => LiveRoomController(roomId: 'r1', myUid: me, repo: _FakeRepo())
  ..detail = RoomDetail.fromJson({
    'id': 'r1',
    'type': type,
    'status': 'live',
    'title': 'Room',
    'host': {'id': 'host', 'displayName': 'User host'},
    'viewerCount': 1,
    'giftDiamonds': 0,
    'livekitRoom': 'bb_host_1',
    'moderatorIds': mods,
    'seats': [
      _seat(0, 'host', diamonds: 5000),
      _seat(
        1,
        guest ? 'me' : null,
        diamonds: 1234,
        videoMuted: guestVideoMuted,
      ),
      _seat(2, null),
    ],
    'swappedUid': swapped,
  });

void main() {
  // LiveKit's Room starts a periodic timer: build controllers outside fake async.
  late LiveRoomController swapped, normal, audio, viewer, solo, camOff, joined;
  setUpAll(() {
    solo = _controller(me: 'me', guest: false);
    camOff = _controller(me: 'me', guestVideoMuted: true);
    // Connected, with nothing published: every camera reads as off.
    joined = _controller(me: 'me')..debugConnected = (_) => true;
    swapped = _controller(me: 'me', mods: ['me'], swapped: 'me');
    normal = _controller(me: 'me', mods: ['me']);
    audio = _controller(me: 'me', mods: ['me'], swapped: 'me', type: 'audio');
    viewer = _controller(me: 'me', swapped: 'me');
  });

  Widget stage(LiveRoomController c, {void Function(String? uid)? onSwap}) =>
      MaterialApp(
        home: MediaQuery(
          data: const MediaQueryData(size: Size(390, 844)),
          child: Scaffold(
            body: LiveStage(
              c: c,
              onTapUser: (_) {},
              onTapEmptySeat: (_) {},
              onSwap: onSwap,
            ),
          ),
        ),
      );

  testWidgets('a swapped guest fills the host tile, both tiles marked', (
    tester,
  ) async {
    await tester.pumpWidget(stage(swapped, onSwap: (_) {}));
    expect(tester.takeException(), isNull);
    final tiles = tester.widgetList<StageTile>(find.byType(StageTile)).toList();
    expect(tiles.map((t) => t.seat.user!.id), ['me', 'host']);
    expect(find.byType(SwapMarker), findsNWidgets(2));
    // The host tile is the big one: the guest now has it.
    final big = tester.getSize(find.byKey(const ValueKey('me')));
    final small = tester.getSize(find.byKey(const ValueKey('host')));
    expect(
      big.width * big.height,
      greaterThanOrEqualTo(small.width * small.height),
    );
    // Each tile keeps its own live balance.
    expect(find.text(Fmt.diamonds(1234)), findsOneWidget);
    expect(find.text(Fmt.diamonds(5000)), findsOneWidget);
  });

  testWidgets('no swap: host first, no markers', (tester) async {
    await tester.pumpWidget(stage(normal, onSwap: (_) {}));
    final tiles = tester.widgetList<StageTile>(find.byType(StageTile)).toList();
    expect(tiles.map((t) => t.seat.user!.id), ['host', 'me']);
    expect(find.byType(SwapMarker), findsNothing);
  });

  testWidgets('long-press swaps in, and restores from either tile', (
    tester,
  ) async {
    final calls = <String?>[];
    await tester.pumpWidget(stage(normal, onSwap: calls.add));
    await tester.longPress(find.byKey(const ValueKey('me')));
    expect(calls, ['me']);
    // Long-pressing the host with nothing swapped does nothing.
    await tester.longPress(find.byKey(const ValueKey('host')));
    expect(calls, ['me']);

    await tester.pumpWidget(stage(swapped, onSwap: calls.add));
    await tester.longPress(find.byKey(const ValueKey('host')));
    await tester.longPress(find.byKey(const ValueKey('me')));
    expect(calls, ['me', null, null]);
  });

  testWidgets('people who can\'t swap get no long-press action', (
    tester,
  ) async {
    // The screen passes no onSwap to them; the stage still shows the swap.
    await tester.pumpWidget(stage(viewer));
    final tiles = tester.widgetList<StageTile>(find.byType(StageTile));
    expect(tiles.every((t) => t.onLongPress == null), isTrue);
    expect(tiles.first.seat.user!.id, 'me');
  });

  testWidgets('audio seats swap places and keep their markers', (tester) async {
    final calls = <String?>[];
    await tester.pumpWidget(stage(audio, onSwap: calls.add));
    expect(tester.takeException(), isNull);
    expect(find.byType(SwapMarker), findsNWidgets(2));
    // The guest's avatar is drawn in the first (host) slot.
    final guest = tester.getTopLeft(find.text('User me'));
    final host = tester.getTopLeft(find.text('User host'));
    expect(guest.dx, lessThan(host.dx));
    await tester.longPress(find.text('User host'));
    expect(calls, [null]);
  });

  group('speaking indicators', () {
    testWidgets('bars show and animate only while speaking', (tester) async {
      Widget bars(bool active) => MaterialApp(
        home: Center(child: SpeakingBars(active: active)),
      );
      await tester.pumpWidget(bars(false));
      expect(find.bySemanticsLabel('Speaking'), findsNothing);
      expect(tester.hasRunningAnimations, isFalse);

      await tester.pumpWidget(bars(true));
      expect(find.bySemanticsLabel('Speaking'), findsOneWidget);
      final before = tester
          .widgetList<Container>(
            find.descendant(
              of: find.byType(SpeakingBars),
              matching: find.byType(Container),
            ),
          )
          .map((c) => c.constraints?.maxHeight)
          .toList();
      await tester.pump(const Duration(milliseconds: 200));
      final after = tester
          .widgetList<Container>(
            find.descendant(
              of: find.byType(SpeakingBars),
              matching: find.byType(Container),
            ),
          )
          .map((c) => c.constraints?.maxHeight)
          .toList();
      expect(after, isNot(equals(before)));
      expect(tester.hasRunningAnimations, isTrue);

      // Stops (and settles) when they stop talking.
      await tester.pumpWidget(bars(false));
      await tester.pumpAndSettle();
      expect(find.bySemanticsLabel('Speaking'), findsNothing);
    });

    testWidgets('the glow pulses only while speaking', (tester) async {
      Widget glow(bool active) => MaterialApp(
        home: Center(
          child: SpeakingGlow(
            active: active,
            child: const SizedBox.square(dimension: 40),
          ),
        ),
      );
      List<BoxShadow>? shadows() =>
          (tester
                      .widget<DecoratedBox>(
                        find.descendant(
                          of: find.byType(SpeakingGlow),
                          matching: find.byType(DecoratedBox),
                        ),
                      )
                      .decoration
                  as BoxDecoration)
              .boxShadow;

      await tester.pumpWidget(glow(false));
      expect(shadows(), isEmpty);
      await tester.pumpWidget(glow(true));
      final first = shadows()!.single.blurRadius;
      await tester.pump(const Duration(milliseconds: 500));
      expect(shadows()!.single.blurRadius, isNot(first));
      await tester.pumpWidget(glow(false));
      await tester.pumpAndSettle();
      expect(shadows(), isEmpty);
    });

    testWidgets('the wave ripples only while speaking', (tester) async {
      Widget wave(bool active, {bool calm = false}) => MaterialApp(
        home: MediaQuery(
          data: MediaQueryData(disableAnimations: calm),
          child: Center(
            child: SpeakingWave(
              active: active,
              child: const SizedBox.square(dimension: 40),
            ),
          ),
        ),
      );
      RenderObject painted() => tester.renderObject(find.byType(SpeakingWave));

      await tester.pumpWidget(wave(false));
      expect(painted(), paintsExactlyCountTimes(#drawCircle, 0));
      expect(tester.hasRunningAnimations, isFalse);

      // The ring at the avatar's edge plus three moving waves.
      await tester.pumpWidget(wave(true));
      expect(painted(), paintsExactlyCountTimes(#drawCircle, 4));
      expect(tester.hasRunningAnimations, isTrue);

      await tester.pumpWidget(wave(false));
      await tester.pumpAndSettle();
      expect(painted(), paintsExactlyCountTimes(#drawCircle, 0));
    });

    testWidgets('reduced motion: a still ring, nothing animating', (
      tester,
    ) async {
      await tester.pumpWidget(
        const MaterialApp(
          home: MediaQuery(
            data: MediaQueryData(disableAnimations: true),
            child: Center(
              child: SpeakingWave(
                active: true,
                child: SizedBox.square(dimension: 40),
              ),
            ),
          ),
        ),
      );
      expect(tester.hasRunningAnimations, isFalse);
      expect(
        tester.renderObject(find.byType(SpeakingWave)),
        paintsExactlyCountTimes(#drawCircle, 2),
      );
    });

    testWidgets('stage tiles use the wave; the solo host keeps the glow', (
      tester,
    ) async {
      await tester.pumpWidget(stage(normal));
      expect(find.byType(SpeakingWave), findsNWidgets(2));
      expect(find.byType(SpeakingGlow), findsNothing);

      await tester.pumpWidget(stage(solo));
      expect(find.byType(SpeakingWave), findsNothing);
      expect(find.byType(SpeakingGlow), findsOneWidget);
    });

    testWidgets('no one speaking: tiles settle with no indicator', (
      tester,
    ) async {
      await tester.pumpWidget(stage(normal, onSwap: (_) {}));
      await tester.pumpAndSettle();
      expect(find.bySemanticsLabel('Speaking'), findsNothing);
    });
  });

  group('camera-off border', () {
    Color borderOf(WidgetTester tester, String uid) {
      final box = tester.widget<AnimatedContainer>(
        find
            .descendant(
              of: find.byKey(ValueKey(uid)),
              matching: find.byType(AnimatedContainer),
            )
            .first,
      );
      return ((box.decoration! as BoxDecoration).border! as Border).top.color;
    }

    testWidgets('a camera turned off by the room is red', (tester) async {
      await tester.pumpWidget(stage(camOff));
      expect(borderOf(tester, 'me'), BBColors.liveRed);
      // Not connected yet: no verdict on the host's camera.
      expect(borderOf(tester, 'host'), isNot(BBColors.liveRed));
    });

    testWidgets('connected with no camera published is red', (tester) async {
      await tester.pumpWidget(stage(joined));
      expect(borderOf(tester, 'me'), BBColors.liveRed);
      expect(borderOf(tester, 'host'), BBColors.liveRed);
    });

    testWidgets('nothing known to be off: the neutral border', (tester) async {
      await tester.pumpWidget(stage(normal));
      expect(borderOf(tester, 'me'), BBColors.champagneTint);
      expect(borderOf(tester, 'host'), BBColors.champagneTint);
    });
  });
}
