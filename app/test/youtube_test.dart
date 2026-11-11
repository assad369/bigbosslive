import 'package:bigboss_live/data/repositories.dart';
import 'package:bigboss_live/features/live/live_room_controller.dart';
import 'package:bigboss_live/models/models.dart';
import 'package:flutter_test/flutter_test.dart';

class _FakeRepo implements LiveRepository {
  final commands = <Map<String, Object?>>[];
  Map<String, dynamic> answer = const {};

  @override
  Future<YouTubeUpdate> youtube(
    String roomId,
    Map<String, Object?> command,
  ) async {
    commands.add(command);
    return YouTubeUpdate.fromJson(answer);
  }

  @override
  dynamic noSuchMethod(Invocation invocation) =>
      throw UnimplementedError('${invocation.memberName}');
}

Map<String, dynamic> _state(int rev, {String? qid, bool playing = true}) => {
  'rev': rev,
  'current': qid == null
      ? null
      : {
          'qid': qid,
          'videoId': 'dQw4w9WgXcQ',
          'title': 'Song $qid',
          'channel': 'Channel',
          'durationSec': 200,
          'addedBy': {'uid': 'host', 'displayName': 'Host'},
          'playing': playing,
          'positionMs': 0,
          'updatedAt': 1000,
        },
  'queue': [
    {
      'qid': 'q2',
      'videoId': 'aaaaaaaaaaa',
      'title': 'Next',
      'durationSec': 90,
      'addedBy': {'uid': 'adm', 'displayName': 'Adm'},
    },
  ],
};

Map<String, dynamic> _room({List<String> mods = const [], Object? youtube}) => {
  'id': 'r1',
  'type': 'video',
  'status': 'live',
  'title': 'Room',
  'host': {'id': 'host', 'displayName': 'Host'},
  'livekitRoom': 'bb_host_1',
  'moderatorIds': mods,
  'seats': const [],
  'youtube': youtube,
};

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('pure helpers', () {
    test('ytPositionMs follows the server clock and clamps to the song', () {
      final cur = YouTubeState.fromJson(_state(1, qid: 'q1')).current!;
      expect(ytPositionMs(cur, 6000), 5000);
      expect(ytPositionMs(cur, 0), 0);
      expect(ytPositionMs(cur, 1 << 40), 200 * 1000);
      final paused = YouTubeState.fromJson(_state(1, qid: 'q1', playing: false))
          .current!;
      expect(ytPositionMs(paused, 99000), 0);
    });

    test('mergeYouTube keeps the newest rev', () {
      final a = YouTubeState.fromJson(_state(3, qid: 'a'));
      final older = YouTubeState.fromJson(_state(2, qid: 'b'));
      final newer = YouTubeState.fromJson(_state(4, qid: 'c'));
      expect(mergeYouTube(a, older), same(a));
      expect(mergeYouTube(a, newer), same(newer));
      expect(mergeYouTube(a, null), same(a));
      expect(mergeYouTube(null, older), same(older));
    });

    test('formats durations and refusals', () {
      expect(ytDuration(187), '3:07');
      expect(ytDuration(3723), '1:02:03');
      expect(ytDuration(-5), '0:00');
      expect(ytRefusalText('not_embeddable'), "Can't play in other apps");
      expect(ytRefusalText('youtube_too_long'), 'Too long');
      expect(ytRefusalText('anything else'), isNull);
      expect(ytThumb('abc'), 'https://i.ytimg.com/vi/abc/mqdefault.jpg');
    });

    test('room detail carries the YouTube state', () {
      final d = RoomDetail.fromJson(_room(youtube: _state(5, qid: 'q1')));
      expect(d.youtube!.rev, 5);
      expect(d.youtube!.current!.title, 'Song q1');
      expect(d.youtube!.queue.single.addedBy.displayName, 'Adm');
      expect(d.youtube!.count, 2);
      expect(RoomDetail.fromJson(_room()).youtube, isNull);
    });
  });

  group('controller', () {
    LiveRoomController controller(
      String me, {
      List<String> mods = const [],
      bool staff = false,
      _FakeRepo? repo,
    }) => LiveRoomController(
      roomId: 'r1',
      myUid: me,
      repo: repo ?? _FakeRepo(),
      isStaff: staff,
      isLiveModerator: staff,
    )..detail = RoomDetail.fromJson(_room(mods: mods));

    test('bb.youtube packets apply in rev order and set the clock', () {
      final c = controller('viewer');
      final now = DateTime.now().millisecondsSinceEpoch;
      c.handleServerPacket('bb.youtube', {
        'youtube': _state(2, qid: 'q1'),
        'serverNow': now + 5000,
      });
      expect(c.youtube!.current!.qid, 'q1');
      expect(c.serverOffsetMs, closeTo(5000, 200));
      // A late, older snapshot is dropped.
      c.handleServerPacket('bb.youtube', {'youtube': _state(1, qid: 'old')});
      expect(c.youtube!.current!.qid, 'q1');
      c.handleServerPacket('bb.youtube', {'youtube': _state(3)});
      expect(c.youtube!.current, isNull);
      c.dispose();
    });

    test('only the host, room admins and staff control the music', () {
      expect(controller('host').canControlYouTube, isTrue);
      expect(controller('adm', mods: ['adm']).canControlYouTube, isTrue);
      expect(controller('boss', staff: true).canControlYouTube, isTrue);
      expect(controller('viewer').canControlYouTube, isFalse);
    });

    test('a command applies the server answer at once', () async {
      final repo = _FakeRepo()
        ..answer = {
          'youtube': _state(7, qid: 'q9'),
          'serverNow': DateTime.now().millisecondsSinceEpoch,
        };
      final c = controller('host', repo: repo);
      final error = await c.youtubeCommand({
        'action': 'play',
        'videoId': 'dQw4w9WgXcQ',
      });
      expect(error, isNull);
      expect(repo.commands.single['action'], 'play');
      expect(c.youtube!.rev, 7);
      expect(c.youtube!.current!.qid, 'q9');
      c.dispose();
    });
  });
}
