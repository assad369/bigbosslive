import '../core/utils/json.dart';

/// Who queued a YouTube song.
class YtAddedBy {
  const YtAddedBy({required this.uid, this.displayName = ''});
  final String uid;
  final String displayName;

  factory YtAddedBy.fromJson(Json j) =>
      YtAddedBy(uid: j.str('uid'), displayName: j.str('displayName'));
}

/// One song in a live's YouTube queue. `qid` names the entry: the same video
/// can be queued again under a new one.
class YtItem {
  const YtItem({
    required this.qid,
    required this.videoId,
    required this.title,
    required this.durationSec,
    required this.addedBy,
    this.channel = '',
  });

  final String qid;
  final String videoId;
  final String title;
  final int durationSec;
  final YtAddedBy addedBy;
  final String channel;

  factory YtItem.fromJson(Json j) => YtItem(
    qid: j.str('qid'),
    videoId: j.str('videoId'),
    title: j.str('title'),
    durationSec: j.integer('durationSec'),
    addedBy: YtAddedBy.fromJson(j.obj('addedBy')),
    channel: j.str('channel'),
  );
}

/// The song playing now, with its server-clock position.
class YtNowPlaying extends YtItem {
  const YtNowPlaying({
    required super.qid,
    required super.videoId,
    required super.title,
    required super.durationSec,
    required super.addedBy,
    super.channel,
    required this.playing,
    required this.positionMs,
    required this.updatedAt,
  });

  final bool playing;

  /// Position at [updatedAt].
  final int positionMs;

  /// Server clock (ms) when [positionMs] was true.
  final int updatedAt;

  factory YtNowPlaying.fromJson(Json j) => YtNowPlaying(
    qid: j.str('qid'),
    videoId: j.str('videoId'),
    title: j.str('title'),
    durationSec: j.integer('durationSec'),
    addedBy: YtAddedBy.fromJson(j.obj('addedBy')),
    channel: j.str('channel'),
    playing: j['playing'] == true,
    positionMs: j.integer('positionMs'),
    updatedAt: j.integer('updatedAt'),
  );

  @override
  bool operator ==(Object other) =>
      other is YtNowPlaying &&
      other.qid == qid &&
      other.playing == playing &&
      other.positionMs == positionMs &&
      other.updatedAt == updatedAt;

  @override
  int get hashCode => Object.hash(qid, playing, positionMs, updatedAt);
}

/// What a live plays from YouTube, as the server holds it. `rev` orders
/// snapshots: an older one is dropped ([mergeYouTube]).
class YouTubeState {
  const YouTubeState({this.current, this.queue = const [], this.rev = 0});

  final YtNowPlaying? current;
  final List<YtItem> queue;
  final int rev;

  /// Songs in Up next, the playing one included.
  int get count => queue.length + (current == null ? 0 : 1);

  factory YouTubeState.fromJson(Json j) {
    final cur = j.objOrNull('current');
    return YouTubeState(
      current: cur == null ? null : YtNowPlaying.fromJson(cur),
      queue: j.list('queue', YtItem.fromJson),
      rev: j.integer('rev'),
    );
  }

  static YouTubeState? tryParse(Object? v) =>
      v is Map<String, dynamic> ? YouTubeState.fromJson(v) : null;
}

/// A search result. `reason` says why an unplayable one can't play.
class YtSearchResult {
  const YtSearchResult({
    required this.videoId,
    required this.title,
    required this.durationSec,
    this.channel = '',
    this.playable = true,
    this.reason,
  });

  final String videoId;
  final String title;
  final int durationSec;
  final String channel;
  final bool playable;
  final String? reason;

  factory YtSearchResult.fromJson(Json j) => YtSearchResult(
    videoId: j.str('videoId'),
    title: j.str('title'),
    durationSec: j.integer('durationSec'),
    channel: j.str('channel'),
    playable: j['playable'] != false,
    reason: j.strOrNull('reason'),
  );
}

class YtSearchPage {
  const YtSearchPage({required this.items, this.nextPageToken});

  factory YtSearchPage.fromJson(Json j) => YtSearchPage(
    items: j.list('items', YtSearchResult.fromJson),
    nextPageToken: j.strOrNull('nextPageToken'),
  );

  final List<YtSearchResult> items;
  final String? nextPageToken;
}

/// The server's answer to a command: the new state and its clock.
class YouTubeUpdate {
  const YouTubeUpdate({this.youtube, this.serverNow});

  factory YouTubeUpdate.fromJson(Json j) => YouTubeUpdate(
    youtube: YouTubeState.tryParse(j['youtube']),
    serverNow: (j['serverNow'] as num?)?.toInt(),
  );

  final YouTubeState? youtube;
  final int? serverNow;
}

/// Where playback is at [serverNowMs]. Pure. Mirrors the API's `ytPosition`.
int ytPositionMs(YtNowPlaying s, int serverNowMs) {
  final elapsed = serverNowMs - s.updatedAt;
  final at = s.playing
      ? s.positionMs + (elapsed < 0 ? 0 : elapsed)
      : s.positionMs;
  return at.clamp(0, s.durationSec * 1000);
}

/// [next] unless it is older than [current]. Pure.
YouTubeState? mergeYouTube(YouTubeState? current, YouTubeState? next) {
  if (next == null) return current;
  if (current != null && next.rev < current.rev) return current;
  return next;
}

/// YouTube's own thumbnail for [videoId] (320×180).
String ytThumb(String videoId) =>
    'https://i.ytimg.com/vi/${Uri.encodeComponent(videoId)}/mqdefault.jpg';

/// "3:07", "1:02:03". Pure.
String ytDuration(int seconds) {
  final s = seconds < 0 ? 0 : seconds;
  final h = s ~/ 3600;
  final m = (s % 3600) ~/ 60;
  final sec = (s % 60).toString().padLeft(2, '0');
  return h > 0 ? '$h:${m.toString().padLeft(2, '0')}:$sec' : '$m:$sec';
}

/// What to tell someone whose song was refused, by the server's reason or code.
String? ytRefusalText(String? code) => switch (code) {
  'not_embeddable' || 'youtube_not_embeddable' => "Can't play in other apps",
  'not_public' || 'youtube_not_public' => 'Private video',
  'live_video' || 'youtube_live_video' => 'Live streams not supported',
  'age_restricted' || 'youtube_age_restricted' => 'Age-restricted',
  'region_blocked' || 'youtube_region_blocked' => 'Not available here',
  'too_long' || 'youtube_too_long' => 'Too long',
  'blocked' || 'youtube_blocked' => 'Not allowed',
  _ => null,
};
