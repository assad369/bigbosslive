import 'package:bigboss_live/core/utils/json.dart';
import 'package:bigboss_live/models/models.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('MeUser.fromJson', () {
    final json = <String, dynamic>{
      'id': 'u1',
      'shortId': '10000001',
      'displayName': 'Golden Boss',
      'avatarUrl': null,
      'bio': 'hi',
      'level': 12,
      'vipTier': 2,
      'followers': 10,
      'following': 3,
      'isLive': true,
      'liveRoomId': 'r1',
      'isAgent': true,
      'adminRole': null,
      'wallet': {'diamonds': 500, 'beans': 70, 'agentStock': 1000},
      'levelProgress': {
        'level': 12,
        'points': 1500,
        'currentLevelPoints': 1000,
        'nextLevelPoints': 2000,
        'isMaxLevel': false,
      },
      'vipExpiresAt': '2030-01-01T00:00:00.000Z',
    };

    test('parses identity, wallet and level progress', () {
      final me = MeUser.fromJson(json);
      expect(me.id, 'u1');
      expect(me.brief.displayName, 'Golden Boss');
      expect(me.brief.vipTier, 2);
      expect(me.wallet.diamonds, 500);
      expect(me.wallet.agentStock, 1000);
      expect(me.isAgent, isTrue);
      expect(me.profile.isLive, isTrue);
      expect(me.levelProgress.fraction, closeTo(0.5, 1e-9));
      expect(me.vipExpiresAt, isNotNull);
    });

    test('withDiamonds keeps everything else', () {
      final next = MeUser.fromJson(json).withDiamonds(42);
      expect(next.wallet.diamonds, 42);
      expect(next.wallet.beans, 70);
      expect(next.brief.shortId, '10000001');
    });
  });

  test('LevelProgress at max level is full', () {
    final p = LevelProgress.fromJson({
      'level': 100,
      'points': 9,
      'currentLevelPoints': 5,
      'nextLevelPoints': null,
      'isMaxLevel': true,
    });
    expect(p.fraction, 1);
  });

  test('tolerates missing and mistyped optional fields', () {
    final room = LiveRoom.fromJson({'id': 'r', 'host': <String, dynamic>{}});
    expect(room.type, 'video');
    expect(room.viewerCount, 0);
    expect(room.host.displayName, 'User');
    expect(room.startedAt, isNull);
  });

  test('RoomDetail parses seats and credentials', () {
    final s = LiveSession.fromJson({
      'room': {
        'id': 'r',
        'type': 'audio',
        'host': {'id': 'h', 'displayName': 'H'},
        'livekitRoom': 'bb_h_1',
        'moderatorIds': ['m'],
        'seats': [
          {
            'index': 0,
            'user': {'id': 'h', 'displayName': 'H'},
            'muted': false,
            'locked': false,
          },
          {'index': 1, 'user': null, 'muted': false, 'locked': true},
        ],
      },
      'credentials': {
        'token': 't',
        'url': 'wss://lk',
        'identity': 'h',
        'role': 'host',
      },
    });
    expect(s.detail.room.isAudio, isTrue);
    expect(s.detail.seats, hasLength(2));
    expect(s.detail.seats[1].locked, isTrue);
    expect(s.credentials.canPublish, isTrue);
  });

  test('PkBattle and paging', () {
    final page = Paged.fromJson<PkBattle>({
      'items': [
        {
          'id': 'b',
          'status': 'active',
          'durationSec': 180,
          'isDraw': false,
          'hosts': [
            {'uid': 'a', 'roomId': 'r1', 'score': 10, 'displayName': 'A'},
            {'uid': 'b', 'roomId': 'r2', 'score': 5, 'displayName': 'B'},
          ],
        },
      ],
      'nextCursor': 'abc',
    }, PkBattle.fromJson);
    expect(page.items.single.isActive, isTrue);
    expect(page.items.single.hosts.first.score, 10);
    expect(page.nextCursor, 'abc');
  });

  test('AppConfig defaults features to on', () {
    final cfg = AppConfig.fromJson({
      'app': {
        'maintenance': true,
        'minSupportedBuild': {'android': 5, 'ios': 3},
      },
      'features': {'pkEnabled': false},
    });
    expect(cfg.maintenance, isTrue);
    expect(cfg.minBuildAndroid, 5);
    expect(cfg.feature('pkEnabled'), isFalse);
    expect(cfg.feature('gamesEnabled'), isTrue);
    expect(cfg.pkDurations, [180, 300, 600]);
  });
}
