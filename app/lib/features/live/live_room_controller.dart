import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:livekit_client/livekit_client.dart';
import 'package:wakelock_plus/wakelock_plus.dart';

import '../../core/network/api_exception.dart';
import '../../core/utils/json.dart';
import '../../data/repositories.dart';
import '../../models/models.dart';

class ChatLine {
  const ChatLine({
    required this.id,
    required this.text,
    this.user,
    this.system = false,
  });
  final String id;
  final String text;
  final UserBrief? user;
  final bool system;
}

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

enum LiveStatus { connecting, live, reconnecting, ended, kicked, failed }

/// Owns one live session: the LiveKit [Room], server data-channel events, chat, gifts, seats,
/// PK state and the host heartbeat. The screen only renders this state.
class LiveRoomController extends ChangeNotifier {
  LiveRoomController({
    required this.roomId,
    required this.myUid,
    required this._repo,
    LiveSession? hostSession,
  }) : _initial = hostSession;

  final String roomId;
  final String myUid;
  final LiveRepository _repo;
  final LiveSession? _initial;

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

  LiveStatus status = LiveStatus.connecting;
  String? error;
  RoomDetail? detail;
  LiveCredentials? credentials;
  final chat = <ChatLine>[];
  final _gifts = StreamController<GiftEvent>.broadcast();
  final _entries = StreamController<UserBrief>.broadcast();
  final _pkInvites = StreamController<PkBattle>.broadcast();
  PkBattle? pk;
  Map<String, List<({UserBrief? user, int score})>> pkContributors = const {};
  bool micOn = true;
  bool cameraOn = true;
  bool frontCamera = true;
  Json? endSummary;

  Stream<GiftEvent> get gifts => _gifts.stream;
  Stream<UserBrief> get entries => _entries.stream;
  Stream<PkBattle> get pkInvites => _pkInvites.stream;

  bool get isHost => detail?.room.host.id == myUid;
  bool get canPublish => credentials?.canPublish ?? false;
  bool get isModerator =>
      isHost || (detail?.moderatorIds.contains(myUid) ?? false);
  bool get onSeat =>
      detail?.seats.any((s) => s.index > 0 && s.user?.id == myUid) ?? false;
  int get viewerCount => detail?.room.viewerCount ?? 0;

  /// The host's camera track (in this room) — the main video.
  VideoTrack? get hostVideo => _videoOf(detail?.room.host.id);

  /// In PK, the opponent host is forwarded into this room by the SFU under their own uid.
  VideoTrack? get opponentVideo {
    final opp = pk?.hosts
        .where((h) => h.uid != detail?.room.host.id)
        .firstOrNull;
    return opp == null ? null : _videoOf(opp.uid);
  }

  VideoTrack? _videoOf(String? uid) {
    if (uid == null) return null;
    if (uid == myUid) {
      return room.localParticipant?.videoTrackPublications
          .where((p) => !p.muted)
          .firstOrNull
          ?.track;
    }
    final p = room.remoteParticipants.values
        .where((p) => p.identity == uid)
        .firstOrNull;
    return p?.videoTrackPublications
        .where((t) => t.subscribed && !t.muted)
        .firstOrNull
        ?.track;
  }

  bool isSpeaking(String uid) {
    if (uid == myUid) return room.localParticipant?.isSpeaking ?? false;
    return room.remoteParticipants.values
            .where((p) => p.identity == uid)
            .firstOrNull
            ?.isSpeaking ??
        false;
  }

  Future<void> start() async {
    try {
      final session = _initial ?? await _repo.join(roomId);
      detail = session.detail;
      credentials = session.credentials;
      _listen();
      await room.connect(session.credentials.url, session.credentials.token);
      if (canPublish) await _publish();
      status = LiveStatus.live;
      _system(
        'Welcome to ${detail!.room.host.displayName}\'s live. Be kind — harassment gets you removed.',
      );
      unawaited(WakelockPlus.enable());
      if (isHost) {
        _heartbeat = Timer.periodic(
          const Duration(seconds: 25),
          (_) => _repo.heartbeat(roomId).catchError((Object e) {
            if (e is ApiException && e.status == 410) _ended();
          }),
        );
      }
      _poll = Timer.periodic(
        const Duration(seconds: 15),
        (_) => _refreshDetail(),
      );
      await _loadPk();
    } on ApiException catch (e) {
      status = e.status == 410 ? LiveStatus.ended : LiveStatus.failed;
      error = e.message;
    } catch (e) {
      status = LiveStatus.failed;
      error = 'Could not connect to the live';
      debugPrint('live connect failed: $e');
    }
    notifyListeners();
  }

  Future<void> _publish() async {
    final audioOnly = detail?.room.isAudio ?? false;
    if (!audioOnly && (isHost || onSeat)) {
      await room.localParticipant?.setCameraEnabled(true);
    }
    await room.localParticipant?.setMicrophoneEnabled(true);
  }

  void _listen() {
    final l = room.createListener();
    _listener = l;
    l
      ..on<TrackSubscribedEvent>((_) => notifyListeners())
      ..on<TrackUnsubscribedEvent>((_) => notifyListeners())
      ..on<TrackMutedEvent>((_) => notifyListeners())
      ..on<TrackUnmutedEvent>((_) => notifyListeners())
      ..on<LocalTrackPublishedEvent>((_) => notifyListeners())
      ..on<ActiveSpeakersChangedEvent>((_) => notifyListeners())
      ..on<ParticipantConnectedEvent>((_) => notifyListeners())
      ..on<ParticipantDisconnectedEvent>((e) {
        if (e.participant.identity == detail?.room.host.id && !isHost) {
          _system('The host stepped away…');
        }
        notifyListeners();
      })
      ..on<RoomReconnectingEvent>((_) {
        status = LiveStatus.reconnecting;
        notifyListeners();
      })
      ..on<RoomReconnectedEvent>((_) {
        status = LiveStatus.live;
        notifyListeners();
      })
      ..on<RoomDisconnectedEvent>((_) {
        if (status == LiveStatus.live || status == LiveStatus.reconnecting) {
          _ended();
        }
      })
      ..on<DataReceivedEvent>(_onData);
  }

  void _onData(DataReceivedEvent e) {
    // Only trust packets the server sent (participant == null); clients cannot forge events.
    if (e.participant != null) return;
    Json packet;
    try {
      packet = jsonDecode(utf8.decode(e.data)) as Json;
    } catch (_) {
      return;
    }
    final topic = packet.str('topic', e.topic ?? '');
    final p = packet.obj('payload');
    switch (topic) {
      case 'bb.chat':
        _addChat(
          ChatLine(
            id: p.str('id'),
            text: p.str('text'),
            user: UserBrief.fromJson(p.obj('user')),
          ),
        );
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
        _gifts.add(event);
        _addChat(
          ChatLine(
            id: 'g${event.id}',
            text: 'sent ${event.gift.name} ×${event.quantity}',
            user: event.sender,
          ),
        );
      case 'bb.entry':
        final u = UserBrief.fromJson(p.obj('user'));
        _entries.add(u);
        _system('${u.displayName} joined');
      case 'bb.kick':
        if (p.str('uid') == myUid) {
          status = LiveStatus.kicked;
          unawaited(_teardown());
        }
      case 'bb.seats':
        if (p['seats'] is List) {
          final d = detail;
          if (d != null) {
            detail = RoomDetail(
              room: d.room,
              livekitRoom: d.livekitRoom,
              moderatorIds: d.moderatorIds,
              seats: p.list('seats', Seat.fromJson),
              backgroundUrl: d.backgroundUrl,
            );
          }
        } else if (p.str('kind') == 'request' && isModerator) {
          _system(
            '${UserBrief.fromJson(p.obj('user')).displayName} wants to join a seat',
          );
        } else if (p.str('kind') == 'invite') {
          _system('The host invited you to a seat');
        }
      case 'bb.system':
        if (p.str('kind') == 'moderator') unawaited(_refreshDetail());
      case 'bb.room.ended':
        _ended();
      case 'bb.pk.invitation':
        _pkInvites.add(PkBattle.fromJson(p.obj('battle')));
      case 'bb.pk.started' ||
          'bb.pk.score' ||
          'bb.pk.ended' ||
          'bb.pk.rejected' ||
          'bb.pk.cancelled' ||
          'bb.pk.expired':
        final b = PkBattle.fromJson(p.obj('battle'));
        pk = (b.status == 'active' || topic == 'bb.pk.ended') ? b : null;
        if (p['contributors'] is Map) {
          pkContributors = _parseContributors(p.obj('contributors'));
        }
        if (topic == 'bb.pk.ended') {
          final winner = b.hosts.where((h) => h.uid == b.winnerUid).firstOrNull;
          _system(
            b.isDraw
                ? 'PK ended in a draw!'
                : '👑 ${winner?.displayName ?? 'Winner'} wins the PK!',
          );
          Timer(const Duration(seconds: 8), () {
            if (pk?.id == b.id && pk?.status == 'ended') {
              pk = null;
              notifyListeners();
            }
          });
        }
        if (topic == 'bb.pk.rejected') _system('PK invitation was declined');
        if (topic == 'bb.pk.expired') _system('PK invitation expired');
    }
    notifyListeners();
  }

  Map<String, List<({UserBrief? user, int score})>> _parseContributors(
    Json j,
  ) => j.map(
    (k, v) => MapEntry(
      k,
      (v as List<dynamic>)
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
      if (j != null && j.objOrNull('battle') != null) {
        final b = PkBattle.fromJson(j.obj('battle'));
        pk = b.isActive ? b : null;
        pkContributors = _parseContributors(j.obj('contributors'));
        notifyListeners();
      }
    } catch (_) {
      /* PK is optional */
    }
  }

  Future<void> _refreshDetail() async {
    try {
      final next = await _repo.detail(roomId);
      if (next.room.status == 'ended') return _ended();
      final wasSeated = onSeat;
      detail = next;
      // Promoted to a seat: start publishing. Removed: stop.
      if (!isHost && onSeat != wasSeated) {
        if (onSeat) {
          await _publish();
        } else {
          await room.localParticipant?.setCameraEnabled(false);
          await room.localParticipant?.setMicrophoneEnabled(false);
        }
      }
      notifyListeners();
    } catch (_) {}
  }

  void _addChat(ChatLine line) {
    if (chat.any((c) => c.id == line.id)) return;
    chat.add(line);
    if (chat.length > 120) chat.removeRange(0, chat.length - 120);
  }

  void _system(String text) => _addChat(
    ChatLine(
      id: 's${DateTime.now().microsecondsSinceEpoch}',
      text: text,
      system: true,
    ),
  );

  void _ended() {
    if (status == LiveStatus.ended) return;
    status = LiveStatus.ended;
    unawaited(_teardown());
    notifyListeners();
  }

  // ── Actions ────────────────────────────────────────────────────────────────

  Future<void> toggleMic() async {
    micOn = !micOn;
    await room.localParticipant?.setMicrophoneEnabled(micOn);
    notifyListeners();
  }

  Future<void> toggleCamera() async {
    cameraOn = !cameraOn;
    await room.localParticipant?.setCameraEnabled(cameraOn);
    notifyListeners();
  }

  Future<void> flipCamera() async {
    final track =
        room.localParticipant?.videoTrackPublications.firstOrNull?.track;
    if (track == null) return;
    frontCamera = !frontCamera;
    await track.setCameraPosition(
      frontCamera ? CameraPosition.front : CameraPosition.back,
    );
    notifyListeners();
  }

  Future<void> sendChat(String text) async {
    final t = text.trim();
    if (t.isEmpty) return;
    await _repo.chat(roomId, t);
  }

  Future<void> requestSeat() => _repo.requestSeat(roomId);
  Future<void> leaveSeat() async {
    await _repo.leaveSeat(roomId);
    await _refreshDetail();
  }

  Future<void> kick(String uid) => _repo.kick(roomId, uid);

  Future<Json?> end() async {
    if (isHost) {
      try {
        endSummary = await _repo.end(roomId);
      } catch (_) {}
    }
    status = LiveStatus.ended;
    await _teardown();
    notifyListeners();
    return endSummary;
  }

  Future<void> _teardown() async {
    _heartbeat?.cancel();
    _poll?.cancel();
    unawaited(WakelockPlus.disable());
    await room.disconnect();
  }

  @override
  void dispose() {
    _heartbeat?.cancel();
    _poll?.cancel();
    unawaited(_listener?.dispose());
    unawaited(room.disconnect().then((_) => room.dispose()));
    unawaited(WakelockPlus.disable());
    _gifts.close();
    _entries.close();
    _pkInvites.close();
    super.dispose();
  }
}
