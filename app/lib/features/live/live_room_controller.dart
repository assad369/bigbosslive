import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:livekit_client/livekit_client.dart';
import 'package:wakelock_plus/wakelock_plus.dart';

import '../../core/network/api_exception.dart';
import '../../core/utils/json.dart';
import '../../data/repositories.dart';
import '../../models/models.dart';

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
  });
  final String id;
  final String text;
  final ChatKind kind;
  final UserBrief? user;
  final RoomRole? role;
  final ChatReply? replyTo;
  final String? voiceUrl;
  final int voiceSec;

  bool get system => kind == ChatKind.system || kind == ChatKind.join;

  /// Server-sent messages can be replied to, reported and deleted; local lines cannot.
  bool get isMessage => kind == ChatKind.chat || kind == ChatKind.voice;

  factory ChatLine.fromServer(Json p) {
    final u = p.obj('user');
    final voice = p.objOrNull('voice');
    final reply = p.objOrNull('replyTo');
    return ChatLine(
      id: p.str('id'),
      text: p.str('text'),
      kind: voice == null ? ChatKind.chat : ChatKind.voice,
      user: UserBrief.fromJson(u),
      role: roleFromMetadata(u.str('role')),
      replyTo: reply == null ? null : ChatReply.fromJson(reply),
      voiceUrl: voice?.str('url'),
      voiceSec: voice?.integer('durationSec') ?? 0,
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
  }) : _initial = hostSession;

  final String roomId;
  final String myUid;
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

  /// The user's own mic/camera choice while on stage, so syncing seat state never undoes it.
  bool _micOffByMe = false;
  bool _cameraOffByMe = false;
  bool _staged = false;
  Json? endSummary;
  int _pendingHearts = 0;

  Stream<GiftEvent> get gifts => _gifts.stream;
  Stream<EntryEvent> get entries => _entries.stream;
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
  Seat? get mySeat => detail?.seats
      .where((s) => s.index > 0 && s.user?.id == myUid)
      .firstOrNull;
  bool get onSeat => mySeat != null;
  bool get isVideoRoom => !(detail?.room.isAudio ?? false);
  int get viewerCount => detail?.room.viewerCount ?? 0;
  bool get locked => detail?.room.locked ?? false;

  /// Everyone on stage (host first), for the participant grid.
  List<Seat> get stage =>
      detail?.seats.where((s) => s.user != null).toList() ?? const [];
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

  bool isConnected(String uid) => _participant(uid) != null;

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
      credentials = session.credentials;
      _listen();
      await room.connect(session.credentials.url, session.credentials.token);
      if (_disposed) return unawaited(_disconnectQuietly());
      await _syncPublishing();
      if (_disposed) return unawaited(_disconnectQuietly());
      status = LiveStatus.live;
      _system(
        'Welcome to ${detail!.room.host.displayName}\'s live. Be kind — harassment gets you removed.',
      );
      _wakelock(on: true);
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
          await local.setCameraEnabled(false);
        } catch (e) {
          debugPrint('unpublish failed: $e');
        }
      }
      return;
    }
    if (!_staged) {
      // Fresh on stage: start with mic and camera on.
      _staged = true;
      _micOffByMe = false;
      _cameraOffByMe = false;
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
        await local.setCameraEnabled(wantCam);
        cameraOn = wantCam;
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
      ..on<TrackSubscribedEvent>((_) => _notify())
      ..on<TrackUnsubscribedEvent>((_) => _notify())
      ..on<TrackMutedEvent>((_) => _notify())
      ..on<TrackUnmutedEvent>((_) => _notify())
      ..on<LocalTrackPublishedEvent>((_) => _notify())
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
          final session = await _repo.join(roomId, password: _password);
          if (_disposed) return;
          detail = session.detail;
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
        _addChat(
          ChatLine(
            id: 'g${event.id}',
            kind: ChatKind.gift,
            text:
                'sent ${event.gift.name} ×${event.quantity} to ${event.receiverNames.join(', ')}',
            user: event.sender,
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
          unawaited(_teardown());
        }
      case 'bb.seats':
        _onSeats(p);
      case 'bb.system':
        _onSystem(p);
      case 'bb.room.ended':
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
        detail = d.copyWith(seats: p.list('seats', Seat.fromJson));
        if (onSeat) seatRequestPending = false;
        unawaited(_syncPublishing());
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
          ? next.copyWith(seats: current.seats)
          : next;
      await _syncPublishing();
      _notify();
    } catch (_) {}
  }

  void _addChat(ChatLine line) {
    if (chat.any((c) => c.id == line.id)) return;
    chat.add(line);
    if (chat.length > _maxChat) chat.removeRange(0, chat.length - _maxChat);
  }

  /// Join lines collapse: a burst of arrivals shows only the latest one.
  void _join(UserBrief u) {
    if (u.id == myUid) return;
    if (chat.isNotEmpty && chat.last.kind == ChatKind.join) chat.removeLast();
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
    } catch (e) {
      _notice('Couldn\'t switch cameras');
    }
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
  Future<void> setAdmin(String uid, bool enabled) =>
      _repo.setModerator(roomId, uid, enabled);

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
    await _disconnectQuietly();
  }

  @override
  void dispose() {
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
    unawaited(room.disconnect().then((_) => room.dispose()));
    _wakelock(on: false);
    _gifts.close();
    _entries.close();
    _pkInvites.close();
    _seatInvites.close();
    _reactions.close();
    _notices.close();
    super.dispose();
  }
}
