import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:livekit_client/livekit_client.dart';
import 'package:wakelock_plus/wakelock_plus.dart';

import '../../core/network/api_exception.dart';
import '../../core/utils/json.dart';
import '../../core/widgets/tier_badge.dart';
import '../../data/repositories.dart';
import '../../models/models.dart';
import 'camera_filter_channel.dart';
import 'camera_filters.dart';

enum ChatKind { chat, voice, gift, join, system }

/// Who someone is in this room, as shown on badges. Derived from server-minted metadata
/// or the room detail; never from what a client claims.
enum RoomRole { host, admin, guest, viewer }

class ChatReply {
  const ChatReply({
    required this.id,
    required this.userId,
    required this.displayName,
    required this.text,
  });
  final String id;
  final String userId;
  final String displayName;
  final String text;
  factory ChatReply.fromJson(Json j) => ChatReply(
    id: j.str('id'),
    userId: j.str('userId'),
    displayName: j.str('displayName'),
    text: j.str('text'),
  );
}

/// What a gift line in the chat shows.
class ChatGift {
  const ChatGift({
    required this.name,
    required this.iconUrl,
    required this.quantity,
    required this.receiverNames,
  });
  final String name;
  final String iconUrl;
  final int quantity;
  final List<String> receiverNames;

  /// How a reply quotes it; the server sends the same text in `replyTo`.
  String get preview => '🎁 $name ×$quantity';

  factory ChatGift.fromJson(Json j) => ChatGift(
    name: j.str('name'),
    iconUrl: j.str('iconUrl'),
    quantity: j.integer('quantity', 1),
    receiverNames: j.list('receivers', (r) => r.str('displayName', 'User')),
  );
}

class ChatLine {
  const ChatLine({
    required this.id,
    required this.text,
    this.kind = ChatKind.chat,
    this.user,
    this.role,
    this.replyTo,
    this.voiceUrl,
    this.voiceSec = 0,
    this.gift,
    this.fromServer = false,
    this.mod = false,
  });
  final String id;
  final String text;
  final ChatKind kind;
  final UserBrief? user;
  final RoomRole? role;
  final ChatReply? replyTo;
  final String? voiceUrl;
  final int voiceSec;
  final ChatGift? gift;

  /// Saved on the server (`live_messages`), so it has an id replies, reports and deletes
  /// can name. Lines the app writes itself (joins, notices, the gift fallback) are not.
  final bool fromServer;

  /// Sent by a hidden platform moderator (decided by the server): drawn with a MOD chip.
  final bool mod;

  bool get system => kind == ChatKind.system || kind == ChatKind.join;

  /// Server-sent messages can be replied to, reported and deleted; local lines cannot.
  bool get isMessage =>
      fromServer &&
      (kind == ChatKind.chat ||
          kind == ChatKind.voice ||
          kind == ChatKind.gift);

  /// How a reply to this line quotes it.
  String get preview => switch (kind) {
    ChatKind.voice => '🎤 Voice message',
    ChatKind.gift when gift != null => gift!.preview,
    _ => text,
  };

  factory ChatLine.fromServer(Json p) {
    final u = p.obj('user');
    final voice = p.objOrNull('voice');
    final reply = p.objOrNull('replyTo');
    final gift = p.str('type') == 'gift' ? p.objOrNull('gift') : null;
    return ChatLine(
      id: p.str('id'),
      text: p.str('text'),
      kind: gift != null
          ? ChatKind.gift
          : voice == null
          ? ChatKind.chat
          : ChatKind.voice,
      user: UserBrief.fromJson(u),
      role: roleFromMetadata(u.str('role')),
      replyTo: reply == null ? null : ChatReply.fromJson(reply),
      voiceUrl: voice?.str('url'),
      voiceSec: voice?.integer('durationSec') ?? 0,
      gift: gift == null ? null : ChatGift.fromJson(gift),
      fromServer: true,
      mod: p.flag('mod'),
    );
  }
}

RoomRole? roleFromMetadata(String role) => switch (role) {
  'host' => RoomRole.host,
  'moderator' => RoomRole.admin,
  'guest' => RoomRole.guest,
  _ => null,
};

class GiftEvent {
  const GiftEvent({
    required this.id,
    required this.sender,
    required this.gift,
    required this.quantity,
    required this.receiverNames,
  });
  final String id;
  final UserBrief? sender;
  final Gift gift;
  final int quantity;
  final List<String> receiverNames;
}

/// Someone with a VIP tier or an entrance effect joined. [effectUrl] plays full-screen.
class EntryEvent {
  const EntryEvent({
    required this.user,
    this.effectUrl,
    this.effectFormat = 'none',
  });
  final UserBrief user;
  final String? effectUrl;
  final String effectFormat;

  factory EntryEvent.fromJson(Json p) {
    // `effect` is current; `animation` (a store cosmetic) is what older servers sent.
    final effect = p.objOrNull('effect');
    final legacy = p.objOrNull('animation');
    return EntryEvent(
      user: UserBrief.fromJson(p.obj('user')),
      effectUrl: effect?.strOrNull('url') ?? legacy?.strOrNull('assetUrl'),
      effectFormat:
          effect?.str('format', 'none') ??
          legacy?.str('animationFormat', 'none') ??
          'none',
    );
  }
}

/// A host or room admin asked this user onto a seat.
class SeatInvite {
  const SeatInvite({required this.from, this.expiresAt});
  final UserBrief from;
  final DateTime? expiresAt;
}

enum LiveStatus { connecting, live, reconnecting, ended, kicked, failed }

/// Owns one live session: the LiveKit [Room], server data-channel events, chat, gifts, seats,
/// room admins, the lock, PK state and the host heartbeat. The screen only renders this state.
class LiveRoomController extends ChangeNotifier {
  LiveRoomController({
    required this.roomId,
    required this.myUid,
    required this._repo,
    LiveSession? hostSession,
    this._password,
    this.isStaff = false,
    this.isLiveModerator = false,
    this.selfStageEnabled = false,
    this.me,
  }) : _initial = hostSession;

  final String roomId;
  final String myUid;

  /// This user, for their own "joined" line (the server's goes to the room before they are
  /// connected, or not at all on a rejoin).
  final UserBrief? me;

  /// Platform staff (any admin role).
  final bool isStaff;

  /// May moderate any live (`/me.moderation.canModerateLive`): a platform moderator, or
  /// staff whose role holds `live.moderate`. The server applies the same rule; this only
  /// decides which controls to draw.
  final bool isLiveModerator;

  /// A platform moderator allowed to take a seat without the host's approval.
  final bool selfStageEnabled;

  /// Connected hidden (a platform moderator in stealth): nobody sees this user, their join
  /// or their entrance. Set from each join, so a rejoin can change it.
  bool stealth = false;
  final LiveRepository _repo;
  final LiveSession? _initial;
  final String? _password;

  static const _maxChat = 120;
  static const _maxRecoveries = 5;

  /// Avatars in the top bar; matches the server's `TOP_VIEWERS`.
  static const _topViewers = 4;

  final room = Room(
    roomOptions: const RoomOptions(
      adaptiveStream: true,
      dynacast: true,
      defaultCameraCaptureOptions: CameraCaptureOptions(
        maxFrameRate: 24,
        params: VideoParametersPresets.h720_169,
      ),
    ),
  );
  EventsListener<RoomEvent>? _listener;
  Timer? _heartbeat;
  Timer? _poll;
  Timer? _pkClear;
  Timer? _reactionFlush;
  Timer? _requestExpiry;
  bool _disposed = false;
  bool _recovering = false;

  /// Bumped by every `bb.seats` event, so a slower poll can't overwrite newer seats.
  int _seatsVersion = 0;
  int _systemSeq = 0;
  Future<void>? _publishing;
  bool _publishAgain = false;

  LiveStatus status = LiveStatus.connecting;
  String? error;

  /// Set when [status] is failed because the room is locked; the screen asks for the password.
  ({bool hasPassword, bool wrong})? lockedOut;
  RoomDetail? detail;
  LiveCredentials? credentials;
  final chat = <ChatLine>[];
  List<UserBrief> topViewers = const [];

  /// Pending seat requests (host and room admins only).
  final seatRequests = <SeatRequest>[];

  /// This viewer's own request is waiting for the host.
  bool seatRequestPending = false;

  final _gifts = StreamController<GiftEvent>.broadcast();
  final _entries = StreamController<EntryEvent>.broadcast();
  final _pkInvites = StreamController<PkBattle>.broadcast();
  final _seatInvites = StreamController<SeatInvite>.broadcast();
  final _reactions = StreamController<int>.broadcast();
  final _notices = StreamController<String>.broadcast();
  PkBattle? pk;

  /// A challenge this host sent that is waiting for an answer.
  PkBattle? pkOutgoing;
  Map<String, List<({UserBrief? user, int score})>> pkContributors = const {};
  bool micOn = false;
  bool cameraOn = false;
  bool frontCamera = true;

  /// My camera filter ([CameraFilters] id) and beauty sliders. The go-live screen and the
  /// room share them through [CameraFilterPrefs].
  String filterId = CameraFilters.defaultFilter.id;
  BeautyParams beauty = BeautyParams.preset;

  /// The speaker toggle: everyone else's audio (and effect sounds) on this device only.
  bool roomAudioOn = true;

  /// The chat over the stage, shown or hidden by its rail button.
  bool chatVisible = true;

  /// YouTube music, kept at the highest rev seen ([mergeYouTube]).
  YouTubeState? youtube;

  /// Server − device clock (ms), from the room detail and every YouTube answer.
  int serverOffsetMs = 0;
  int get serverNowMs => DateTime.now().millisecondsSinceEpoch + serverOffsetMs;

  /// The user's own mic/camera choice while on stage, so syncing seat state never undoes it.
  bool _micOffByMe = false;
  bool _cameraOffByMe = false;
  bool _staged = false;
  bool _seatReleased = false;
  Json? endSummary;

  /// Why the live ended (`bb.room.ended` reason), e.g. `moderation`; null when unknown.
  String? endReason;

  /// True when automated moderation (not the host or a room admin) removed me.
  bool removedByModeration = false;
  int _pendingHearts = 0;

  Stream<GiftEvent> get gifts => _gifts.stream;

  /// Entrances in this room. A subscriber that arrives just after this user's own entrance
  /// still gets it: the effect and banner widgets mount only once the room has rendered,
  /// which can be after the join announced it, and a broadcast stream would drop it.
  Stream<EntryEvent> get entries => Stream<EntryEvent>.multi((sink) {
    final own = _ownEntry;
    if (own != null &&
        DateTime.now().difference(own.at) < _ownEntryReplayWindow) {
      sink.add(own.event);
    }
    final sub = _entries.stream.listen(sink.add, onDone: sink.close);
    sink.onCancel = sub.cancel;
  });

  /// This user's own entrance, replayed to [entries] subscribers for a short while.
  ({EntryEvent event, DateTime at})? _ownEntry;
  static const _ownEntryReplayWindow = Duration(seconds: 8);
  Stream<PkBattle> get pkInvites => _pkInvites.stream;
  Stream<SeatInvite> get seatInvites => _seatInvites.stream;

  /// Heart reactions from others (own taps are drawn locally).
  Stream<int> get reactions => _reactions.stream;

  /// Short messages for the user (snackbars), e.g. "Your seat request was declined".
  Stream<String> get notices => _notices.stream;

  bool get isHost => detail?.room.host.id == myUid;
  bool get canPublish => credentials?.canPublish ?? false;

  /// The host or a room admin: can manage seats, requests and remove people.
  bool get isModerator =>
      isHost || (detail?.moderatorIds.contains(myUid) ?? false);

  /// The host, room admins, platform moderators and `live.moderate` staff play YouTube songs.
  bool get canControlYouTube => isModerator || isLiveModerator;

  /// May remove people, delete their messages and end this live although they neither host
  /// nor administer it (a platform moderator or `live.moderate` staff).
  bool get canModerateLive => isLiveModerator;

  /// A platform moderator may take a seat (or leave it) without anyone's approval.
  bool get canSelfStage => selfStageEnabled && !isHost;
  Seat? get mySeat => detail?.seats
      .where((s) => s.index > 0 && s.user?.id == myUid)
      .firstOrNull;
  bool get onSeat => mySeat != null;
  bool get isVideoRoom => !(detail?.room.isAudio ?? false);
  int get viewerCount => detail?.room.viewerCount ?? 0;
  bool get locked => detail?.room.locked ?? false;

  /// Everyone on stage (host first), for the participant grid. A guest who has left LiveKit
  /// drops out at once, before the server frees their seat (its webhook can lag, and a
  /// killed app leaves no goodbye at all). While a guest is swapped into the host spot they
  /// come first and the host takes their place.
  ///
  /// Guests keep the order they sat down in ([Seat.seatedAt]), not the seat index: the
  /// server hands a newcomer the lowest free seat, which would otherwise put a late joiner
  /// above everyone already on stage.
  List<Seat> get stage => _swapped(_joinOrder());

  /// The host, then present guests in the order they took their seats.
  List<Seat> _joinOrder() {
    final present =
        detail?.seats.where((s) => s.user != null && _present(s)).toList() ??
        <Seat>[];
    present.sort(compareStageOrder);
    return present;
  }

  /// Host first, then by [Seat.seatedAt] (older servers send none: seat index decides).
  @visibleForTesting
  static int compareStageOrder(Seat a, Seat b) {
    if (a.index == 0 || b.index == 0) return a.index == 0 ? -1 : 1;
    final at = a.seatedAt, bt = b.seatedAt;
    if (at != null && bt != null && at != bt) return at.compareTo(bt);
    if (at != null && bt == null) return 1;
    if (at == null && bt != null) return -1;
    return a.index.compareTo(b.index);
  }

  /// [uid]'s spot on the stage: 1 for the first guest to sit down, 2 for the next, and so
  /// on among those present. Null for the host and anyone not on stage. A swap into the
  /// host spot keeps the guest's number.
  int? spotOf(String uid) {
    final guests = _joinOrder().where((s) => s.index > 0).toList();
    final i = guests.indexWhere((s) => s.user?.id == uid);
    return i < 0 ? null : i + 1;
  }

  /// The host's wallet balance, kept current by `balances` seat events (the host sits on
  /// seat 0, so every change to it reaches the room).
  int get hostDiamonds =>
      detail?.seats.where((s) => s.index == 0).firstOrNull?.diamonds ?? 0;

  /// Whether this user may take [seat]'s guest off the stage: the host, a room admin (not
  /// for another admin; the server refuses that) or staff with `live.moderate`.
  bool canRemoveFromStage(Seat seat) {
    final uid = seat.user?.id;
    if (seat.index == 0 || uid == null || uid == myUid) return false;
    if (isHost || isLiveModerator) return true;
    return isModerator && roleOf(uid) != RoomRole.admin;
  }

  /// All seats as they should be drawn: a guest who has left shows as an empty seat. A
  /// swap exchanges the host seat and the guest's seat.
  List<Seat> get displaySeats => _swapped([
    for (final s in detail?.seats ?? const <Seat>[])
      s.user == null || _present(s) ? s : s.vacant,
  ]);

  /// The guest in the host's spot, only while they are on a seat and still here.
  String? get activeSwap {
    final uid = detail?.swappedUid;
    if (uid == null) return null;
    final seat = detail!.seats
        .where((s) => s.index > 0 && s.user?.id == uid)
        .firstOrNull;
    return seat != null && _present(seat) ? uid : null;
  }

  /// The host and room admins (and staff) move a guest into the host spot and back.
  bool get canSwap => isModerator || isLiveModerator;

  /// What long-pressing [seat] does for someone who [canSwap]: the guest to move into the
  /// host spot, `(uid: null)` to restore the layout, or null when there is nothing to do.
  ({String? uid})? swapActionFor(Seat seat) {
    final uid = seat.user?.id;
    if (!canSwap || uid == null) return null;
    final active = activeSwap;
    if (seat.index == 0) return active == null ? null : (uid: null);
    return active == uid ? (uid: null) : (uid: uid);
  }

  /// [uid] is the host or the guest of an active swap: their tiles carry the swap marker.
  bool isSwapped(String uid) {
    final guest = activeSwap;
    return guest != null && (uid == guest || uid == detail?.room.host.id);
  }

  List<Seat> _swapped(List<Seat> seats) {
    final guest = activeSwap;
    if (guest == null) return seats;
    final host = seats.indexWhere((s) => s.index == 0);
    final other = seats.indexWhere((s) => s.user?.id == guest);
    if (host < 0 || other < 0) return seats;
    final out = [...seats];
    out[host] = seats[other];
    out[other] = seats[host];
    return out;
  }

  /// The host and this user are always shown; anyone else only while connected.
  bool _present(Seat s) {
    final uid = s.user?.id;
    if (uid == null) return false;
    return s.index == 0 || uid == myUid || isConnected(uid);
  }

  bool get hasFreeSeat =>
      detail?.seats.any((s) => s.index > 0 && s.user == null && !s.locked) ??
      false;

  RoomRole roleOf(String uid) {
    final d = detail;
    if (d == null) return RoomRole.viewer;
    if (d.room.host.id == uid) return RoomRole.host;
    if (d.moderatorIds.contains(uid)) return RoomRole.admin;
    if (d.seats.any((s) => s.index > 0 && s.user?.id == uid)) {
      return RoomRole.guest;
    }
    return RoomRole.viewer;
  }

  /// The host's camera track (in this room) — the main video.
  VideoTrack? get hostVideo => videoOf(detail?.room.host.id);

  /// In PK, the opponent host is forwarded into this room by the SFU under their own uid.
  VideoTrack? get opponentVideo {
    final opp = pkOpponent;
    return opp == null ? null : videoOf(opp.uid);
  }

  PkHost? get pkOpponent =>
      pk?.hosts.where((h) => h.uid != detail?.room.host.id).firstOrNull;

  Participant? _participant(String uid) => uid == myUid
      ? room.localParticipant
      : room.remoteParticipants.values
            .where((p) => p.identity == uid)
            .firstOrNull;

  bool isConnected(String uid) =>
      debugConnected?.call(uid) ?? _participant(uid) != null;

  /// Stands in for LiveKit's participant list in tests, where no room connects.
  @visibleForTesting
  bool Function(String uid)? debugConnected;

  VideoTrack? videoOf(String? uid) {
    if (uid == null) return null;
    final p = _participant(uid);
    if (p == null) return null;
    return p.videoTrackPublications
            .where((t) => !t.muted && (p is LocalParticipant || t.subscribed))
            .firstOrNull
            ?.track
        as VideoTrack?;
  }

  bool isMicOn(String uid) =>
      _participant(uid)?.audioTrackPublications.any((t) => !t.muted) ?? false;

  bool isSpeaking(String uid) => _participant(uid)?.isSpeaking ?? false;

  /// Who is speaking right now. Changes several times a second, so it has its own
  /// listenable: only the tiles that draw the speaking ring rebuild, not the whole screen.
  final speakers = ValueNotifier<int>(0);

  Future<void> start() async {
    try {
      final session = _initial ?? await _repo.join(roomId, password: _password);
      // Closed while joining (back pressed, another live opened): never connect, and never
      // start timers or the wakelock that dispose() has already cleaned up.
      if (_disposed) return;
      detail = session.detail;
      stealth = session.stealth;
      _takeYouTube(session.detail);
      credentials = session.credentials;
      // Before connecting, so the first camera publish already streams the saved look.
      final filter = await CameraFilterPrefs.load();
      if (_disposed) return;
      filterId = filter.filterId;
      beauty = filter.beauty;
      _listen();
      await room.connect(session.credentials.url, session.credentials.token);
      if (_disposed) return unawaited(_disconnectQuietly());
      await _syncPublishing();
      if (_disposed) return unawaited(_disconnectQuietly());
      status = LiveStatus.live;
      _system(
        'Welcome to ${detail!.room.host.displayName}\'s live. Be kind — harassment gets you removed.',
      );
      _announceMyJoin(session.entry);
      _wakelock(on: true);
      // LiveKit now holds video decoders: tier badge MP4s get a smaller share.
      VideoBadgeBudget.instance.inLiveRoom = true;
      if (isHost) {
        _heartbeat = Timer.periodic(
          const Duration(seconds: 25),
          (_) => _repo.heartbeat(roomId).catchError((Object e) {
            if (e is ApiException && e.status == 410) _ended();
          }),
        );
      }
      // Data-channel events keep state current; the poll only repairs anything missed.
      _poll = Timer.periodic(
        const Duration(seconds: 30),
        (_) => refreshDetail(),
      );
      await Future.wait([_loadPk(), _loadSeatRequests(), _loadTopViewers()]);
    } on ApiException catch (e) {
      if (_disposed) return;
      unawaited(_teardown());
      status = e.status == 410 ? LiveStatus.ended : LiveStatus.failed;
      error = e.message;
      if (e.code == 'room_locked' || e.code == 'wrong_password') {
        final details = e.details;
        lockedOut = (
          hasPassword: details is Map && details['hasPassword'] == true,
          wrong: e.code == 'wrong_password',
        );
      }
    } catch (e) {
      if (_disposed) return;
      // It may have connected (and be publishing) before failing.
      unawaited(_teardown());
      status = LiveStatus.failed;
      error = 'Could not connect to the live';
      debugPrint('live connect failed: $e');
    }
    _notify();
  }

  /// Best effort: a missing or failing wakelock plugin must not surface as a crash.
  static void _wakelock({required bool on}) {
    unawaited(
      (on ? WakelockPlus.enable() : WakelockPlus.disable()).catchError(
        (Object e) => debugPrint('wakelock ${on ? 'on' : 'off'} failed: $e'),
      ),
    );
  }

  Future<void> _disconnectQuietly() async {
    try {
      await room.disconnect();
    } catch (_) {}
  }

  /// Publish while on stage (host or seated guest), stop when not. Seat mutes set by the
  /// host or an admin win over the guest's own toggles.
  ///
  /// Runs one at a time: seat events, permission updates, the poll and the user's toggles
  /// all ask for it, and overlapping calls would publish and unpublish against each other.
  /// A request that arrives mid-run makes it run once more with the latest state.
  Future<void> _syncPublishing() {
    final running = _publishing;
    if (running != null) {
      _publishAgain = true;
      return running;
    }
    final run = () async {
      try {
        do {
          _publishAgain = false;
          await _applyPublishing();
        } while (_publishAgain && !_disposed);
      } finally {
        _publishing = null;
      }
    }();
    _publishing = run;
    return run;
  }

  Future<void> _applyPublishing() async {
    final local = room.localParticipant;
    if (local == null || _disposed) return;
    final staged = isHost || onSeat;
    final allowed = local.permissions.canPublish;
    final seat = isHost ? null : mySeat;
    if (!staged || !allowed) {
      _staged = false;
      if (micOn || cameraOn) {
        micOn = false;
        cameraOn = false;
        try {
          await local.setMicrophoneEnabled(false);
          await CameraFilterChannel.clear(_cameraTrack);
          await local.setCameraEnabled(false);
        } catch (e) {
          debugPrint('unpublish failed: $e');
        }
      }
      return;
    }
    if (!_staged) {
      // Fresh on stage: mic on. The host's camera starts on; a guest's starts off and the
      // guest turns it on when ready.
      _staged = true;
      _micOffByMe = false;
      _cameraOffByMe = !isHost;
    }
    final wantMic = !(seat?.muted ?? false) && !_micOffByMe;
    final wantCam =
        isVideoRoom && !(seat?.videoMuted ?? false) && !_cameraOffByMe;
    if (wantMic != micOn) {
      try {
        await local.setMicrophoneEnabled(wantMic);
        micOn = wantMic;
      } catch (e) {
        // Usually a denied permission. Treat it as the user's own "off" so we don't retry
        // on every seat event, and say why.
        debugPrint('mic ${wantMic ? 'on' : 'off'} failed: $e');
        if (wantMic) {
          _micOffByMe = true;
          _notice(
            'Couldn\'t turn on your microphone. Check that BigBoss Live may use it.',
          );
        }
      }
    }
    if (wantCam != cameraOn) {
      try {
        // Detach while the capture thread can still free the filter's GPU resources.
        if (!wantCam) await CameraFilterChannel.clear(_cameraTrack);
        await local.setCameraEnabled(wantCam);
        cameraOn = wantCam;
        // Turning the camera back on restarts capture with a new native track.
        if (wantCam) await _applyFilter();
      } catch (e) {
        debugPrint('camera ${wantCam ? 'on' : 'off'} failed: $e');
        if (wantCam) {
          _cameraOffByMe = true;
          _notice(
            'Couldn\'t turn on your camera. Check that BigBoss Live may use it.',
          );
        }
      }
    }
  }

  void _notice(String message) {
    if (!_notices.isClosed) _notices.add(message);
  }

  void _listen() {
    final l = room.createListener();
    _listener = l;
    l
      ..on<TrackSubscribedEvent>((_) {
        // Someone new started speaking while the room is silenced on this device.
        if (!roomAudioOn) _applyRoomAudio();
        _notify();
      })
      ..on<TrackUnsubscribedEvent>((_) => _notify())
      ..on<TrackMutedEvent>((_) => _notify())
      ..on<TrackUnmutedEvent>((_) => _notify())
      ..on<LocalTrackPublishedEvent>((e) {
        // A fresh camera track (first publish, or the rejoin after a lost connection).
        if (e.publication.source == TrackSource.camera) {
          unawaited(_applyFilter());
        }
        _notify();
      })
      ..on<ActiveSpeakersChangedEvent>((_) {
        if (!_disposed) speakers.value++;
      })
      ..on<ParticipantConnectedEvent>((_) => _notify())
      ..on<ParticipantPermissionsUpdatedEvent>((e) {
        // The server grants publish just before broadcasting the seat change.
        if (e.participant is LocalParticipant) unawaited(_syncPublishing());
        _notify();
      })
      ..on<ParticipantDisconnectedEvent>((e) {
        if (e.participant.identity == detail?.room.host.id && !isHost) {
          _system('The host stepped away…');
        }
        _notify();
      })
      ..on<RoomReconnectingEvent>((_) {
        status = LiveStatus.reconnecting;
        _notify();
      })
      ..on<RoomReconnectedEvent>((_) {
        status = LiveStatus.live;
        _notify();
      })
      ..on<RoomDisconnectedEvent>(_onDisconnected)
      ..on<DataReceivedEvent>(_onData);
  }

  void _onDisconnected(RoomDisconnectedEvent e) {
    if (status != LiveStatus.live && status != LiveStatus.reconnecting) return;
    switch (e.reason) {
      case DisconnectReason.participantRemoved:
        status = LiveStatus.kicked;
        unawaited(_teardown());
        _notify();
      case DisconnectReason.roomDeleted:
        _ended();
      case DisconnectReason.clientInitiated:
        _ended();
      case DisconnectReason.duplicateIdentity:
        error = 'You joined this live from another device.';
        _ended();
      default:
        unawaited(_recover());
    }
  }

  /// LiveKit gave up resuming: rejoin through the API (fresh token, current role) with
  /// backoff, so a network change doesn't end the session.
  Future<void> _recover() async {
    if (_recovering) return;
    _recovering = true;
    status = LiveStatus.reconnecting;
    _notify();
    try {
      for (var attempt = 1; attempt <= _maxRecoveries; attempt++) {
        await Future<void>.delayed(Duration(seconds: attempt * 2));
        if (_disposed) return;
        try {
          // `resume`: everyone already saw this user arrive; no second entrance.
          final session = await _repo.join(
            roomId,
            password: _password,
            resume: true,
          );
          if (_disposed) return;
          detail = session.detail;
          stealth = session.stealth;
          _takeYouTube(session.detail);
          credentials = session.credentials;
          micOn = false;
          cameraOn = false;
          // The rejoin publishes a fresh camera track, which opens on the front camera.
          frontCamera = true;
          await room.connect(
            session.credentials.url,
            session.credentials.token,
          );
          if (_disposed) return unawaited(_disconnectQuietly());
          await _syncPublishing();
          if (_disposed) return;
          status = LiveStatus.live;
          _notify();
          // Events missed while offline: a PK that ended, requests that came or went.
          unawaited(Future.wait([_loadPk(), _loadSeatRequests()]));
          return;
        } on ApiException catch (e) {
          if (_disposed) return;
          if (e.status == 410) return _ended();
          if (e.status == 403) {
            status = LiveStatus.kicked;
            unawaited(_teardown());
            _notify();
            return;
          }
        } catch (e) {
          debugPrint('live rejoin $attempt failed: $e');
        }
      }
      if (_disposed) return;
      status = LiveStatus.failed;
      error = 'Lost connection to the live';
      await _teardown();
      _notify();
    } finally {
      _recovering = false;
    }
  }

  void _onData(DataReceivedEvent e) {
    // Only trust packets the server sent (participant == null); clients cannot forge events.
    if (e.participant != null) return;
    if (_disposed) return;
    try {
      final packet = jsonDecode(utf8.decode(e.data)) as Json;
      handleServerPacket(
        packet.str('topic', e.topic ?? ''),
        packet.obj('payload'),
      );
    } catch (err) {
      // A malformed or unexpected packet must not take the room down with it.
      debugPrint('live packet dropped: $err');
    }
  }

  /// Applies one server event. Public for tests; production input is [_onData].
  @visibleForTesting
  void handleServerPacket(String topic, Json p) {
    if (_disposed) return;
    switch (topic) {
      case 'bb.chat':
        if (p.str('id').isEmpty) return;
        _addChat(ChatLine.fromServer(p));
      case 'bb.gift':
        final sender = p.objOrNull('sender');
        final event = GiftEvent(
          id: p.str('transactionId'),
          sender: sender == null ? null : UserBrief.fromJson(sender),
          gift: Gift.fromJson(p.obj('gift')),
          quantity: p.integer('quantity', 1),
          receiverNames: p.list(
            'receivers',
            (r) => r.str('displayName', 'Host'),
          ),
        );
        if (!_gifts.isClosed) _gifts.add(event);
        // The committed room total, so the "diamonds this live" counter never drifts.
        final total = p['roomGiftDiamonds'];
        final d = detail;
        if (total is int && d != null) {
          detail = d.copyWith(room: d.room.copyWith(giftDiamonds: total));
        }
        // The server saves the line as a chat message and sends it along. An older server
        // (or a failed save) sends none, so write a local line. Same id either way, so a
        // gift never shows twice.
        final message = p.objOrNull('message');
        _addChat(
          message != null && message.str('id').isNotEmpty
              ? ChatLine.fromServer(message)
              : ChatLine(
                  id: event.id,
                  kind: ChatKind.gift,
                  text:
                      'sent ${event.gift.name} ×${event.quantity} to ${event.receiverNames.join(', ')}',
                  user: event.sender,
                  gift: ChatGift(
                    name: event.gift.name,
                    iconUrl: event.gift.iconUrl,
                    quantity: event.quantity,
                    receiverNames: event.receiverNames,
                  ),
                ),
        );
      // Stream-only events: their widgets listen to the streams, nothing else changes, so
      // they don't rebuild the room.
      case 'bb.entry':
        if (!_entries.isClosed) _entries.add(EntryEvent.fromJson(p));
        return;
      case 'bb.reaction':
        if (p.str('uid') != myUid && !_reactions.isClosed) {
          _reactions.add(p.integer('count', 1));
        }
        return;
      case 'bb.kick':
        if (p.str('uid') == myUid) {
          status = LiveStatus.kicked;
          removedByModeration = p.strOrNull('by') == 'system';
          unawaited(_teardown());
        }
      case 'bb.seats':
        _onSeats(p);
      case 'bb.system':
        _onSystem(p);
      case 'bb.youtube':
        _applyYouTube(
          YouTubeState.tryParse(p['youtube']),
          (p['serverNow'] as num?)?.toInt(),
        );
      case 'bb.room.ended':
        endReason = p.strOrNull('reason');
        _ended();
      case 'bb.pk.invitation':
        if (!_pkInvites.isClosed) {
          _pkInvites.add(PkBattle.fromJson(p.obj('battle')));
        }
        return;
      case 'bb.pk.started' ||
          'bb.pk.score' ||
          'bb.pk.round_ended' ||
          'bb.pk.round_started' ||
          'bb.pk.ended' ||
          'bb.pk.rejected' ||
          'bb.pk.cancelled' ||
          'bb.pk.expired':
        _onPk(topic, p);
    }
    _notify();
  }

  void _onSeats(Json p) {
    final d = detail;
    switch (p.str('kind', p['seats'] is List ? 'seats' : '')) {
      case 'seats':
        if (d == null) return;
        _seatsVersion++;
        detail = d.copyWith(
          seats: p.list('seats', Seat.fromJson),
          swappedUid: () => p.strOrNull('swappedUid'),
        );
        if (onSeat) seatRequestPending = false;
        unawaited(_syncPublishing());
      case 'balances':
        // Diamond balance and level of people on stage, after any wallet change.
        if (d == null) return;
        final next = {
          for (final u in p.list('users', (u) => u))
            u.str('uid'): (
              diamonds: u.integer('diamonds'),
              level: u.integer('level'),
            ),
        };
        if (next.isEmpty) return;
        detail = d.copyWith(
          seats: [
            for (final s in d.seats)
              switch (next[s.user?.id]) {
                null => s,
                final n => s.copyWith(
                  diamonds: n.diamonds,
                  user: s.user!.copyWith(level: n.level),
                ),
              },
          ],
        );
      case 'request':
        if (!isModerator) return;
        final user = UserBrief.fromJson(p.obj('user'));
        seatRequests
          ..removeWhere((r) => r.user.id == user.id)
          ..add(SeatRequest(user: user, expiresAt: p.date('expiresAt')));
        _system('${user.displayName} wants to join the stage');
      case 'request_resolved':
        final uid = p.str('uid');
        seatRequests.removeWhere((r) => r.user.id == uid);
        if (uid == myUid) {
          seatRequestPending = false;
          _requestExpiry?.cancel();
          if (!p.flag('accepted')) {
            _notice('Your request to join the stage was declined');
          }
        }
      case 'invite':
        if (_seatInvites.isClosed) return;
        _seatInvites.add(
          SeatInvite(
            from: UserBrief.fromJson(p.obj('from')),
            // Server time; the dialog counts down on this device's clock.
            expiresAt: p
                .date('expiresAt')
                ?.subtract(d?.clockOffset ?? Duration.zero),
          ),
        );
      case 'invite_declined':
        _system(
          '${UserBrief.fromJson(p.obj('user')).displayName} declined the invitation',
        );
    }
  }

  void _onSystem(Json p) {
    final d = detail;
    if (d == null) return;
    switch (p.str('kind')) {
      case 'moderator':
        final uid = p.str('uid');
        final enabled = p.flag('enabled');
        final user = p.objOrNull('user');
        detail = d.copyWith(
          moderatorIds: enabled
              ? {...d.moderatorIds, uid}.toList()
              : d.moderatorIds.where((m) => m != uid).toList(),
          moderators: enabled
              ? [
                  ...d.moderators.where((m) => m.id != uid),
                  if (user != null) UserBrief.fromJson(user),
                ]
              : d.moderators.where((m) => m.id != uid).toList(),
        );
        if (user != null) {
          final name = UserBrief.fromJson(user).displayName;
          _system(
            enabled
                ? '$name is now a room admin'
                : '$name is no longer a room admin',
          );
        }
        if (uid == myUid) {
          if (enabled) {
            unawaited(_loadSeatRequests());
          } else {
            seatRequests.clear();
          }
        }
      case 'lock':
        final isLocked = p.flag('locked');
        detail = d.copyWith(
          room: d.room.copyWith(
            locked: isLocked,
            hasPassword: p.flag('hasPassword'),
          ),
        );
        _system(
          isLocked
              ? 'The host locked this live. New viewers can’t join.'
              : 'The host unlocked this live',
        );
      case 'room_updated':
        detail = d.copyWith(
          room: d.room.copyWith(
            title: p.strOrNull('title'),
            coverUrl: p.strOrNull('coverUrl'),
          ),
          backgroundUrl: () => p.strOrNull('backgroundUrl'),
        );
      case 'viewers':
        detail = d.copyWith(
          room: d.room.copyWith(viewerCount: p.integer('count')),
        );
        topViewers = p.list('top', UserBrief.fromJson);
        final joined = p.objOrNull('joined');
        if (joined != null) _join(UserBrief.fromJson(joined));
      case 'chat_deleted':
        chat.removeWhere((c) => c.id == p.str('id'));
      case 'moderation':
        _onModeration(p);
    }
  }

  /// Automated moderation notices, sent to this participant only.
  void _onModeration(Json p) {
    switch (p.str('action')) {
      case 'warn':
        _notice(
          'Your live may break our community guidelines. '
          'Continued violations will end it.',
        );
      case 'muted':
        // The SFU already muted the track; turn it off here too so the controls
        // show the truth and it stays off until the user turns it back on.
        final audio = p.str('media') == 'audio';
        if (audio) {
          _micOffByMe = true;
        } else {
          _cameraOffByMe = true;
        }
        unawaited(_syncPublishing());
        _notice(
          audio
              ? 'Your mic was turned off for breaking our community guidelines'
              : 'Your camera was turned off for breaking our community guidelines',
        );
    }
  }

  void _onPk(String topic, Json p) {
    final b = PkBattle.fromJson(p.obj('battle'));
    final mine =
        pk?.id == b.id || pkOutgoing?.id == b.id || topic == 'bb.pk.started';
    if (!mine) return;
    if (p['contributors'] is Map) {
      pkContributors = _parseContributors(p.obj('contributors'));
    }
    final opponent = b.hosts
        .where((h) => h.uid != detail?.room.host.id)
        .firstOrNull;
    switch (topic) {
      case 'bb.pk.rejected' || 'bb.pk.cancelled' || 'bb.pk.expired':
        if (pkOutgoing?.id == b.id) pkOutgoing = null;
        if (pk?.id == b.id) pk = null;
        if (isHost && b.invitedBy == myUid) {
          _notice(switch (topic) {
            'bb.pk.rejected' =>
              '${opponent?.displayName ?? 'The host'} declined your PK',
            'bb.pk.expired' => 'No answer to your PK challenge',
            _ => 'PK challenge cancelled',
          });
        }
        return;
      case 'bb.pk.started':
        pkOutgoing = null;
        pkContributors = const {};
        _system('⚔️ PK started against ${opponent?.displayName ?? 'a host'}!');
      case 'bb.pk.round_ended':
        final last = b.rounds.lastOrNull;
        final w = last == null ? null : b.host(last.winnerUid ?? '');
        _system(
          w == null
              ? 'Round ${b.round} is a draw'
              : 'Round ${b.round} goes to ${w.displayName}',
        );
      case 'bb.pk.ended':
        final winner = b.host(b.winnerUid ?? '');
        _system(
          b.isDraw
              ? 'PK ended in a draw!'
              : '👑 ${winner?.displayName ?? 'Winner'} wins the PK!',
        );
        _pkClear?.cancel();
        _pkClear = Timer(const Duration(seconds: 10), () {
          if (pk?.id == b.id && pk!.isEnded) {
            pk = null;
            _notify();
          }
        });
    }
    pk = b;
  }

  Map<String, List<({UserBrief? user, int score})>> _parseContributors(
    Json j,
  ) => j.map(
    (k, v) => MapEntry(
      k,
      (v is List<dynamic> ? v : const <dynamic>[])
          .whereType<Json>()
          .map(
            (c) => (
              user: c.objOrNull('user') == null
                  ? null
                  : UserBrief.fromJson(c.obj('user')),
              score: c.integer('score'),
            ),
          )
          .toList(),
    ),
  );

  Future<void> _loadPk() async {
    try {
      final j = await _repo.pkForRoom(roomId);
      if (_disposed) return;
      if (j == null || j.objOrNull('battle') == null) {
        // Nothing running (e.g. it ended while we were reconnecting).
        if (pk != null && !pk!.isEnded) {
          pk = null;
          _notify();
        }
        return;
      }
      final b = PkBattle.fromJson(j.obj('battle'));
      if (b.isActive) {
        pk = b;
      } else if (b.status == 'pending' && b.invitedBy == myUid) {
        pkOutgoing = b;
      } else if (pk?.id == b.id) {
        // Ended while we weren't listening: show the result rather than a frozen arena.
        pk = b;
      }
      if (pkOutgoing?.id == b.id && b.status != 'pending') pkOutgoing = null;
      pkContributors = _parseContributors(j.obj('contributors'));
      _notify();
    } catch (_) {
      /* PK is optional */
    }
  }

  Future<void> _loadSeatRequests() async {
    if (!isModerator) return;
    try {
      final rows = await _repo.seatRequests(roomId);
      if (_disposed) return;
      seatRequests
        ..clear()
        ..addAll(rows);
      _notify();
    } catch (_) {}
  }

  /// Fills the avatar strip on entry; `viewers` events keep it current after that.
  Future<void> _loadTopViewers() async {
    try {
      final rows = await _repo.viewers(roomId);
      if (_disposed || topViewers.isNotEmpty) return;
      topViewers = rows.take(_topViewers).toList();
      _notify();
    } catch (_) {}
  }

  /// Repairs room state from the server (the 30 s poll, and after leaving a seat).
  @visibleForTesting
  Future<void> refreshDetail() async {
    try {
      final version = _seatsVersion;
      final next = await _repo.detail(roomId);
      if (_disposed) return;
      if (next.room.status == 'ended') return _ended();
      // A seats event that arrived while this was in flight is newer than the poll.
      final current = detail;
      detail = version != _seatsVersion && current != null
          ? next.copyWith(
              seats: current.seats,
              swappedUid: () => current.swappedUid,
            )
          : next;
      _takeYouTube(next);
      await _syncPublishing();
      _notify();
    } catch (_) {}
  }

  void _addChat(ChatLine line) {
    if (chat.any((c) => c.id == line.id)) return;
    chat.add(line);
    if (chat.length > _maxChat) chat.removeRange(0, chat.length - _maxChat);
  }

  /// My own "joined" line, shown once per session as soon as I'm connected; the server's
  /// copy reaches the room before I am in it (and is skipped on a rejoin). A VIP also sees
  /// their own entrance banner and effect, which the room got while they were connecting.
  bool _myJoinShown = false;

  void _announceMyJoin(Json? entry) {
    // A hidden moderator arrives unannounced, to the room and to themselves.
    if (isHost || stealth) return;
    final self = me;
    if (self != null && !_myJoinShown) _join(self);
    if (entry != null && !_entries.isClosed) {
      final EntryEvent event;
      try {
        event = EntryEvent.fromJson(entry);
      } catch (_) {
        // A malformed entrance is cosmetic: never fail the join over it.
        return;
      }
      _ownEntry = (event: event, at: DateTime.now());
      _entries.add(event);
    }
  }

  /// [_announceMyJoin] for tests, which can't connect a real room.
  @visibleForTesting
  void debugAnnounceMyJoin(Json? entry) => _announceMyJoin(entry);

  /// Join lines collapse: a burst of arrivals shows only the latest one. My own line is
  /// never collapsed away by someone else's, and appears only once.
  void _join(UserBrief u) {
    if (u.id == myUid) {
      if (_myJoinShown) return;
      _myJoinShown = true;
    }
    if (chat.isNotEmpty &&
        chat.last.kind == ChatKind.join &&
        chat.last.user?.id != myUid) {
      chat.removeLast();
    }
    _addChat(
      ChatLine(
        id: 'j${u.id}-${_systemSeq++}',
        kind: ChatKind.join,
        text: 'joined',
        user: u,
      ),
    );
  }

  void _system(String text) => _addChat(
    ChatLine(id: 's${_systemSeq++}', text: text, kind: ChatKind.system),
  );

  void _ended() {
    if (status == LiveStatus.ended) return;
    status = LiveStatus.ended;
    unawaited(_teardown());
    _notify();
  }

  void _notify() {
    if (!_disposed) notifyListeners();
  }

  // ── YouTube music ──────────────────────────────────────────────────────────

  /// The room as read from the server: its YouTube state, and its clock.
  void _takeYouTube(RoomDetail d) {
    serverOffsetMs = d.clockOffset.inMilliseconds;
    youtube = mergeYouTube(youtube, d.youtube);
  }

  void _applyYouTube(YouTubeState? next, int? serverNow) {
    final merged = mergeYouTube(youtube, next);
    if (identical(merged, youtube)) return;
    youtube = merged;
    if (serverNow != null) {
      serverOffsetMs = serverNow - DateTime.now().millisecondsSinceEpoch;
    }
    _notify();
  }

  /// YouTube songs matching [q], or the video a pasted link names. Throws [ApiException].
  Future<YtSearchPage> youtubeSearch(String q, {String? pageToken}) =>
      _repo.youtubeSearch(roomId, q, pageToken: pageToken);

  /// A YouTube command (`play`, `enqueue`, `pause`, `next`, …). The answer is applied at
  /// once, ordered with the packets by its rev. Returns the error to show, or null.
  Future<String?> youtubeCommand(Map<String, Object?> command) async {
    try {
      final res = await _repo.youtube(roomId, command);
      if (!_disposed) _applyYouTube(res.youtube, res.serverNow);
      return null;
    } on ApiException catch (e) {
      return e.message;
    } catch (_) {
      return 'Something went wrong, try again';
    }
  }

  /// This device's player reached the end of [qid]. The server checks it against its own
  /// clock before moving on, so a failure is ignored.
  Future<void> youtubeEnded(String qid) async {
    try {
      final res = await _repo.youtubeEnded(roomId, qid);
      if (!_disposed) _applyYouTube(res.youtube, res.serverNow);
    } catch (_) {}
  }

  // ── Actions ────────────────────────────────────────────────────────────────

  /// The user's own choice, applied through [_syncPublishing] so it can't race seat
  /// events, and a failure (denied permission) leaves the button showing the truth.
  Future<void> toggleMic() async {
    if (_disposed) return;
    if (!micOn && (mySeat?.muted ?? false)) {
      _notice('An admin muted your mic');
      return;
    }
    _micOffByMe = micOn;
    await _syncPublishing();
    _notify();
  }

  Future<void> toggleCamera() async {
    if (_disposed) return;
    if (!cameraOn && (mySeat?.videoMuted ?? false)) {
      _notice('An admin turned your camera off');
      return;
    }
    _cameraOffByMe = cameraOn;
    await _syncPublishing();
    _notify();
  }

  Future<void> flipCamera() async {
    final track =
        room.localParticipant?.videoTrackPublications.firstOrNull?.track;
    if (track == null || _disposed) return;
    final next = !frontCamera;
    try {
      await track.setCameraPosition(
        next ? CameraPosition.front : CameraPosition.back,
      );
      frontCamera = next;
      // Switching restarts capture with a new native track: re-attach the filter.
      await _applyFilter();
    } catch (e) {
      _notice('Couldn\'t switch cameras');
    }
    _notify();
  }

  LocalVideoTrack? get _cameraTrack {
    final track = room.localParticipant
        ?.getTrackPublicationBySource(TrackSource.camera)
        ?.track;
    return track is LocalVideoTrack ? track : null;
  }

  Future<void> _applyFilter() => CameraFilterChannel.apply(
    _cameraTrack,
    CameraFilters.byId(filterId),
    beauty: beauty,
  );

  /// Changes my camera filter (remembered on this device).
  Future<void> setFilter(String id) async {
    if (_disposed) return;
    filterId = CameraFilters.byId(id).id;
    _notify();
    unawaited(CameraFilterPrefs.saveFilter(filterId));
    await _applyFilter();
  }

  /// Changes the beauty sliders. While a slider is dragged ([persist] false) the stream
  /// follows but nothing is written; the room doesn't rebuild either way, since the sheet
  /// shows its own values.
  Future<void> setBeauty(BeautyParams value, {bool persist = true}) async {
    if (_disposed) return;
    beauty = value;
    if (persist) unawaited(CameraFilterPrefs.saveBeauty(value));
    await _applyFilter();
  }

  void toggleRoomAudio() {
    if (_disposed) return;
    roomAudioOn = !roomAudioOn;
    _applyRoomAudio();
    _notify();
  }

  void _applyRoomAudio() {
    for (final p in room.remoteParticipants.values) {
      for (final pub in p.audioTrackPublications) {
        unawaited(roomAudioOn ? pub.enable() : pub.disable());
      }
    }
  }

  void toggleChat() {
    chatVisible = !chatVisible;
    _notify();
  }

  Future<void> sendChat(String text, {String? replyToId}) async {
    final t = text.trim();
    if (t.isEmpty) return;
    await _repo.chat(roomId, t, replyToId: replyToId);
  }

  Future<void> sendVoice(File file, int seconds, {String? replyToId}) =>
      _repo.voiceChat(roomId, file, seconds, replyToId: replyToId);

  Future<void> deleteMessage(String id) => _repo.deleteChat(roomId, id);

  /// Own hearts are drawn at once and sent in small batches (the API is rate-limited).
  void react() {
    _pendingHearts++;
    _reactionFlush ??= Timer(const Duration(milliseconds: 800), () {
      final count = _pendingHearts.clamp(1, 20);
      _pendingHearts = 0;
      _reactionFlush = null;
      unawaited(_repo.react(roomId, count).catchError((Object _) {}));
    });
  }

  Future<void> requestSeat() async {
    await _repo.requestSeat(roomId);
    seatRequestPending = true;
    _requestExpiry?.cancel();
    _requestExpiry = Timer(const Duration(seconds: 60), () {
      seatRequestPending = false;
      _notify();
    });
    _notify();
  }

  Future<void> cancelSeatRequest() async {
    await _repo.cancelSeatRequest(roomId);
    seatRequestPending = false;
    _requestExpiry?.cancel();
    _notify();
  }

  Future<void> leaveSeat() async {
    await _repo.leaveSeat(roomId);
    await refreshDetail();
  }

  Future<void> respondToSeatInvite(bool accept) =>
      _repo.respondToSeatInvite(roomId, accept);

  Future<void> decideSeat(String uid, bool accept) async {
    try {
      await _repo.decideSeat(roomId, uid, accept);
    } on ApiException catch (e) {
      // Expired or handled by another admin: drop it either way.
      if (e.status != 404) rethrow;
    }
    seatRequests.removeWhere((r) => r.user.id == uid);
    _notify();
  }

  Future<void> inviteToSeat(String uid) => _repo.inviteToSeat(roomId, uid);
  Future<void> manageSeat(int index, String action) =>
      _repo.manageSeat(roomId, index, action);
  Future<void> kick(String uid, {int? banMinutes = 60}) =>
      _repo.kick(roomId, uid, banMinutes: banMinutes);

  /// A platform moderator takes a free seat without approval ([onStage]), or leaves it.
  /// Applied from a fresh room detail; everyone else gets the next `seats` event.
  Future<void> setPlatformModeratorStage({required bool onStage}) async {
    final hidden = await _repo.platformModeratorStage(roomId, onStage: onStage);
    if (_disposed) return;
    // Seated, this user is visible like any guest; back in the audience, hidden again
    // when stealth is on. The server says which.
    stealth = hidden;
    await refreshDetail();
  }

  Future<void> setAdmin(String uid, bool enabled) =>
      _repo.setModerator(roomId, uid, enabled);

  /// Moves seated guest [uid] into the host's stage spot, or restores the layout (null).
  /// Applied at once from the reply; everyone else gets it in the next `seats` event.
  Future<void> swapStage(String? uid) async {
    final next = await _repo.swapStage(roomId, uid);
    final d = detail;
    if (_disposed || d == null) return;
    _seatsVersion++;
    detail = d.copyWith(swappedUid: () => next);
    _notify();
  }

  Future<void> setLock({required bool locked, String? password}) async {
    final next = await _repo.setLock(
      roomId,
      locked: locked,
      password: password,
    );
    detail = detail?.copyWith(room: next.room) ?? next;
    _notify();
  }

  Future<void> invitePk(String opponentId, int durationSec) async {
    pkOutgoing = await _repo.pkInvite(opponentId, durationSec);
    _notify();
  }

  Future<void> randomPk(int durationSec) async {
    pkOutgoing = await _repo.pkRandom(durationSec);
    _notify();
  }

  Future<void> cancelPkInvite() async {
    final b = pkOutgoing;
    if (b == null) return;
    pkOutgoing = null;
    _notify();
    await _repo.pkCancel(b.id).catchError((Object _) {});
  }

  Future<void> nextPkRound() async {
    final b = pk;
    if (b != null) await _repo.pkNextRound(b.id);
  }

  Future<void> endPk() async {
    final b = pk;
    if (b != null) await _repo.pkEnd(b.id);
  }

  /// Ends a hosted live. Throws when the server didn't end it (it is still running), so the
  /// host can retry instead of believing it ended.
  Future<Json?> end() async {
    _releaseSeat();
    if (isHost) {
      try {
        endSummary = await _repo.end(roomId);
      } on ApiException catch (e) {
        // Already ended on the server: nothing left to do.
        if (e.status != 404 && e.status != 410) rethrow;
      }
    }
    status = LiveStatus.ended;
    await _teardown();
    _notify();
    return endSummary;
  }

  Future<void> _teardown() async {
    _heartbeat?.cancel();
    _poll?.cancel();
    _requestExpiry?.cancel();
    _wakelock(on: false);
    await CameraFilterChannel.clear(_cameraTrack);
    await _disconnectQuietly();
  }

  /// A guest closing the live frees their seat now instead of waiting for LiveKit's webhook,
  /// so everyone else's stage updates at once. Best effort: the server sweep is the backstop.
  void _releaseSeat() {
    if (_seatReleased || isHost || !onSeat) return;
    if (status != LiveStatus.live && status != LiveStatus.reconnecting) return;
    _seatReleased = true;
    unawaited(_repo.leaveSeat(roomId).then((_) {}, onError: (Object _) {}));
  }

  @override
  void dispose() {
    _releaseSeat();
    // A host whose live never got going (failed to connect) closes it on the server too,
    // instead of leaving it listed until the stale-room sweep.
    if (isHost && status == LiveStatus.failed) {
      unawaited(_repo.end(roomId).then((_) {}, onError: (Object _) {}));
    }
    _disposed = true;
    speakers.dispose();
    _heartbeat?.cancel();
    _poll?.cancel();
    _pkClear?.cancel();
    _reactionFlush?.cancel();
    _requestExpiry?.cancel();
    unawaited(_listener?.dispose());
    // Sent ahead of the disconnect, which stops the camera: platform messages keep order.
    unawaited(CameraFilterChannel.clear(_cameraTrack));
    unawaited(room.disconnect().then((_) => room.dispose()));
    _wakelock(on: false);
    VideoBadgeBudget.instance.inLiveRoom = false;
    _gifts.close();
    _entries.close();
    _pkInvites.close();
    _seatInvites.close();
    _reactions.close();
    _notices.close();
    super.dispose();
  }
}
