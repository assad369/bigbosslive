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

Map<String, dynamic> _seat(int index, String? uid, {int diamonds = 0}) => {
  'index': index,
  'userId': uid,
  'muted': false,
  'videoMuted': false,
  'locked': false,
  'user': uid == null ? null : {'id': uid, 'displayName': 'User $uid'},
  'diamonds': diamonds,
};

LiveRoomController _controller({
  required String me,
  List<String> mods = const [],
  String? swapped,
  String type = 'video',
}) =>
    LiveRoomController(roomId: 'r1', myUid: me, repo: _FakeRepo())
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
          _seat(1, 'me', diamonds: 1234),
          _seat(2, null),
        ],
        'swappedUid': swapped,
      });

void main() {
  // LiveKit's Room starts a periodic timer: build controllers outside fake async.
  late LiveRoomController swapped, normal, audio, viewer;
  setUpAll(() {
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
    expect(find.text(Fmt.full(1234)), findsOneWidget);
    expect(find.text(Fmt.full(5000)), findsOneWidget);
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

    testWidgets('no one speaking: tiles settle with no indicator', (
      tester,
    ) async {
      await tester.pumpWidget(stage(normal, onSwap: (_) {}));
      await tester.pumpAndSettle();
      expect(find.bySemanticsLabel('Speaking'), findsNothing);
    });
  });
}
