import 'dart:async';

import 'package:bigboss_live/features/live/gift_banner.dart';
import 'package:bigboss_live/models/models.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

Map<String, dynamic> _payload(
  String id, {
  String sender = 'Ann',
  int quantity = 3,
  List<String> to = const ['Bob'],
}) => {
  'id': id,
  'roomId': 'r1',
  'sender': {'id': 'u-$sender', 'shortId': '201', 'displayName': sender},
  'receivers': [
    for (final name in to) {'id': 'u-$name', 'displayName': name},
  ],
  'gift': {'id': 'g1', 'name': 'Rose', 'iconUrl': ''},
  'quantity': quantity,
  'totalCost': 30,
  'at': '2026-11-10T00:00:00.000Z',
};

GiftAnnouncement _a(String id, {String sender = 'Ann'}) =>
    GiftAnnouncement.tryParse(_payload(id, sender: sender))!;

void main() {
  group('GiftAnnouncement', () {
    test('parses the server payload into the banner text', () {
      final a = GiftAnnouncement.tryParse(_payload('t1', to: ['Bob', 'Cy']))!;
      expect(a.id, 't1');
      expect(a.roomId, 'r1');
      expect(a.sender.displayName, 'Ann');
      expect(a.text, 'Ann sent Rose ×3 to Bob, Cy');
      expect(
        GiftAnnouncement.tryParse(_payload('t2', to: []))!.text,
        'Ann sent Rose ×3',
      );
    });

    test('rejects payloads without an id, sender or gift', () {
      expect(GiftAnnouncement.tryParse({..._payload('t1'), 'id': ''}), isNull);
      expect(
        GiftAnnouncement.tryParse({..._payload('t1')}..remove('sender')),
        isNull,
      );
      expect(
        GiftAnnouncement.tryParse({..._payload('t1')}..remove('gift')),
        isNull,
      );
      expect(GiftAnnouncement.tryParse(const {}), isNull);
    });
  });

  group('GiftBannerQueue', () {
    testWidgets('shows one at a time, with a gap between banners', (
      tester,
    ) async {
      final q = GiftBannerQueue(
        display: const Duration(seconds: 6),
        gap: const Duration(milliseconds: 600),
      );
      addTearDown(q.dispose);
      q
        ..add(_a('t1'))
        ..add(_a('t2'));
      expect(q.current?.id, 't1');
      expect(q.waiting, 1);
      await tester.pump(const Duration(seconds: 6));
      expect(q.current, isNull); // the gap
      await tester.pump(const Duration(milliseconds: 599));
      expect(q.current, isNull);
      await tester.pump(const Duration(milliseconds: 1));
      expect(q.current?.id, 't2');
      await tester.pump(const Duration(seconds: 7));
      expect(q.current, isNull);
      expect(q.waiting, 0);
    });

    testWidgets('drops repeats of a gift already shown or waiting', (
      tester,
    ) async {
      final q = GiftBannerQueue();
      addTearDown(q.dispose);
      q
        ..add(_a('t1'))
        ..add(_a('t1'))
        ..add(_a('t2'))
        ..add(_a('t2'));
      expect(q.waiting, 1);
      await tester.pump(const Duration(seconds: 20));
      // t1 again after it was shown: still a repeat.
      q.add(_a('t1'));
      expect(q.current, isNull);
      expect(q.waiting, 0);
    });

    testWidgets('a burst keeps only the newest waiting', (tester) async {
      final q = GiftBannerQueue(capacity: 3);
      addTearDown(q.dispose);
      for (var i = 0; i < 10; i++) {
        q.add(_a('t$i'));
      }
      expect(q.current?.id, 't0');
      expect(q.waiting, 3);
      final shown = <String>[];
      q.addListener(() {
        final id = q.current?.id;
        if (id != null) shown.add(id);
      });
      await tester.pump(const Duration(minutes: 1));
      expect(shown, ['t7', 't8', 't9']);
    });

    testWidgets('dispose cancels the timers', (tester) async {
      final q = GiftBannerQueue()..add(_a('t1'));
      q.dispose();
      await tester.pump(const Duration(seconds: 10));
      // No pending timer may fire on a disposed notifier.
      expect(tester.takeException(), isNull);
    });
  });

  group('GiftBannerOverlay', () {
    Widget overlay(Stream<GiftAnnouncement> s, {double width = 390}) =>
        MediaQuery(
          data: MediaQueryData(size: Size(width, 800)),
          child: MaterialApp(
            home: Scaffold(body: GiftBannerOverlay(announcements: s, top: 120)),
          ),
        );

    testWidgets('shows each announcement from the stream, then clears', (
      tester,
    ) async {
      final ctrl = StreamController<GiftAnnouncement>();
      addTearDown(ctrl.close);
      await tester.pumpWidget(overlay(ctrl.stream));
      expect(find.byType(GiftBanner), findsNothing);

      ctrl
        ..add(_a('t1'))
        ..add(_a('t1')) // redelivered
        ..add(_a('t2', sender: 'Cy'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 300));
      expect(find.byType(GiftBanner), findsOneWidget);
      expect(find.text('Ann sent Rose ×3 to Bob'), findsOneWidget);
      expect(find.text('×3'), findsOneWidget);

      // Still up just before its time is over.
      await tester.pump(const Duration(milliseconds: 5600));
      expect(find.text('Ann sent Rose ×3 to Bob'), findsOneWidget);
      expect(find.text('Cy sent Rose ×3 to Bob'), findsNothing);
      // Then it fades out, and after the gap the next one comes in.
      for (var i = 0; i < 6; i++) {
        await tester.pump(const Duration(milliseconds: 200));
      }
      expect(find.text('Ann sent Rose ×3 to Bob'), findsNothing);
      expect(find.text('Cy sent Rose ×3 to Bob'), findsOneWidget);

      await tester.pump(const Duration(seconds: 10));
      await tester.pumpAndSettle();
      expect(find.byType(GiftBanner), findsNothing);
    });

    testWidgets(
      'a long line fits the pill on a narrow phone and scrolls once',
      (tester) async {
        tester.view.physicalSize = const Size(320, 640);
        tester.view.devicePixelRatio = 1;
        addTearDown(tester.view.reset);
        final ctrl = StreamController<GiftAnnouncement>();
        addTearDown(ctrl.close);
        await tester.pumpWidget(
          MaterialApp(
            home: Scaffold(body: GiftBannerOverlay(announcements: ctrl.stream)),
          ),
        );
        ctrl.add(
          GiftAnnouncement.tryParse(
            _payload(
              't9',
              sender: 'A sender with a remarkably long display name',
              to: ['Someone else with an equally long name', 'And a third'],
            ),
          )!,
        );
        await tester.pump();
        await tester.pump(const Duration(milliseconds: 300));
        expect(tester.takeException(), isNull);
        final pill = tester.getSize(find.byType(GiftBanner));
        expect(pill.width, closeTo(320 * GiftBanner.widthFactor, 0.5));
        expect(pill.height, GiftBanner.height);
        // The scroll runs once and stops: nothing keeps animating afterwards.
        await tester.pump(const Duration(seconds: 20));
        await tester.pumpAndSettle();
        expect(tester.takeException(), isNull);
      },
    );

    testWidgets('never takes touches from the room underneath', (tester) async {
      final ctrl = StreamController<GiftAnnouncement>();
      addTearDown(ctrl.close);
      await tester.pumpWidget(overlay(ctrl.stream));
      expect(
        find.descendant(
          of: find.byType(GiftBannerOverlay),
          matching: find.byWidgetPredicate(
            (w) => w is IgnorePointer && w.ignoring,
          ),
        ),
        findsOneWidget,
      );
    });
  });

  test('UserBrief survives a minimal sender', () {
    final a = GiftAnnouncement.tryParse({
      'id': 'x',
      'sender': {'id': 'u1'},
      'gift': {'name': 'Rose'},
    })!;
    expect(a.sender, isA<UserBrief>());
    expect(a.quantity, 1);
    expect(a.receiverNames, isEmpty);
  });
}
