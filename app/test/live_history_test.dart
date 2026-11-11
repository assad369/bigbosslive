import 'package:bigboss_live/data/repositories.dart';
import 'package:bigboss_live/models/models.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('query helpers format the month and the UTC offset', () {
    expect(historyMonthKey(DateTime(2026, 3, 31)), '2026-03');
    expect(historyMonthKey(DateTime(2026, 11)), '2026-11');
    expect(utcOffsetLabel(const Duration(hours: 6)), '+06:00');
    expect(utcOffsetLabel(const Duration(hours: 5, minutes: 45)), '+05:45');
    expect(utcOffsetLabel(const Duration(hours: -3, minutes: -30)), '-03:30');
    expect(utcOffsetLabel(Duration.zero), '+00:00');
  });

  test('a month of history parses its days and lives', () {
    final m = LiveHistoryMonth.fromJson({
      'month': '2026-03',
      'totalSeconds': 2400,
      'sessionCount': 2,
      'liveDays': 2,
      'diamonds': 280,
      'earliestMonth': '2025-12',
      'days': [
        {
          'date': '2026-03-16',
          'totalSeconds': 1800,
          'sessionCount': 1,
          'peakViewers': 4,
          'diamonds': 0,
          'sessions': [
            {
              'id': 'r2',
              'type': 'audio',
              'title': '',
              'startedAt': '2026-03-15T19:00:00.000Z',
              'endedAt': '2026-03-15T19:30:00.000Z',
              'durationSec': 1800,
              'peakViewers': 4,
              'giftDiamonds': 0,
              'endReason': 'host',
            },
          ],
        },
      ],
    });
    expect(m.month, DateTime(2026, 3));
    expect(m.earliestMonth, DateTime(2025, 12));
    expect(m.liveDays, 2);
    final day = m.days.single;
    expect(day.date, DateTime(2026, 3, 16));
    final live = day.sessions.single;
    expect(live.isAudio, isTrue);
    expect(live.label, 'Audio live');
    expect(live.durationSec, 1800);
  });

  test('a never-live host has no earliest month', () {
    final m = LiveHistoryMonth.fromJson({'month': '2026-03', 'days': []});
    expect(m.earliestMonth, isNull);
    expect(m.days, isEmpty);
  });

  test('a summary keeps unknown counters as null', () {
    final s = LiveSummary.fromJson({
      'roomId': 'r1',
      'type': 'video',
      'title': 'Friday',
      'startedAt': '2026-03-15T12:00:00.000Z',
      'endedAt': '2026-03-15T12:10:00.000Z',
      'endReason': 'host',
      'durationSec': 600,
      'final': false,
      'audience': {
        'peakViewers': 9,
        'totalJoins': null,
        'uniqueViewers': 2,
        'newFollowers': 1,
      },
      'engagement': {'chatMessages': null, 'reactions': 3},
      'gifts': {
        'hostDiamonds': 400,
        'hostEarnings': 280,
        'roomDiamonds': 500,
        'giftCount': 5,
        'gifters': 2,
        'topGifters': [
          {
            'rank': 1,
            'user': {'id': 'fan', 'displayName': 'Fan', 'shortId': '300'},
            'diamonds': 300,
            'gifts': 3,
          },
          {'rank': 2, 'user': null, 'diamonds': 200, 'gifts': 2},
        ],
        'topGifts': [
          {
            'gift': {'id': 'g1', 'name': 'Rose', 'iconUrl': null},
            'count': 5,
            'diamonds': 500,
          },
        ],
      },
    });
    expect(s.isFinal, isFalse);
    expect(s.totalJoins, isNull);
    expect(s.uniqueViewers, 2);
    expect(s.chatMessages, isNull);
    expect(s.reactions, 3);
    expect(s.hostEarnings, 280);
    expect(s.topGifters.first.user!.id, 'fan');
    expect(s.topGifters.last.user, isNull);
    expect(s.topGifts.single.name, 'Rose');
  });

  test('profiles carry the balance only when the server sends it', () {
    expect(
      PublicUser.fromJson({'id': 'u', 'diamonds': 1250000}).diamonds,
      1250000,
    );
    expect(PublicUser.fromJson({'id': 'u'}).diamonds, isNull);
  });

  test('the star rate falls back to one lakh', () {
    AppConfig parse(Object? rate) => AppConfig.fromJson({
      'app': {'diamondsPerStar': rate},
    });
    expect(parse(250000).diamondsPerStar, 250000);
    expect(parse(null).diamondsPerStar, 100000);
    expect(parse(0).diamondsPerStar, 100000);
  });

  test('a join answer carries the joiner\'s own entrance', () {
    final session = LiveSession.fromJson({
      'room': {
        'id': 'r1',
        'host': {'id': 'h'},
        'seats': [],
      },
      'credentials': {'token': 't', 'url': 'wss://x'},
      'entry': {
        'user': {'uid': 'me', 'vipTier': 2},
        'effect': null,
      },
    });
    expect(session.entry, isNotNull);
    expect(
      LiveSession.fromJson({
        'room': {
          'id': 'r1',
          'host': {'id': 'h'},
          'seats': [],
        },
        'credentials': {'token': 't', 'url': 'wss://x'},
      }).entry,
      isNull,
    );
  });
}
