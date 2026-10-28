import '../core/utils/json.dart';

/// Compact identity used in rooms, chat, leaderboards and lists.
class UserBrief {
  const UserBrief({
    required this.id,
    required this.shortId,
    required this.displayName,
    this.avatarUrl,
    this.level = 0,
    this.vipTier = 0,
    this.country,
    this.frameUrl,
    this.frameFormat = 'none',
  });

  final String id;
  final String shortId;
  final String displayName;
  final String? avatarUrl;
  final int level;

  /// 0 none, 1 VIP, 2 VVIP, 3 King.
  final int vipTier;
  final String? country;

  /// Resolved avatar frame (equipped store frame, else the VIP tier's frame).
  final String? frameUrl;

  /// How [frameUrl] plays: `none` (image), `svga`, `lottie`.
  final String frameFormat;

  factory UserBrief.fromJson(Json j) => UserBrief(
    id: j.str('id', j.str('uid')),
    shortId: j.str('shortId'),
    displayName: j.str('displayName', 'User'),
    avatarUrl: j.strOrNull('avatarUrl'),
    level: j.integer('level'),
    vipTier: j.integer('vipTier'),
    country: j.strOrNull('country'),
    frameUrl: j.strOrNull('frameUrl'),
    frameFormat: j.str('frameFormat', 'none'),
  );
}

/// One of an agent's transfers to a user.
class AgentRecharge {
  const AgentRecharge({
    required this.id,
    this.user,
    required this.diamonds,
    this.createdAt,
  });
  final String id;
  final UserBrief? user;
  final int diamonds;
  final DateTime? createdAt;
  factory AgentRecharge.fromJson(Json j) => AgentRecharge(
    id: j.str('id'),
    user: j.objOrNull('user') == null
        ? null
        : UserBrief.fromJson(j.obj('user')),
    diamonds: j.integer('diamonds'),
    createdAt: j.date('createdAt'),
  );
}

class AgentSummary {
  const AgentSummary({
    this.count = 0,
    this.totalDiamonds = 0,
    this.todayDiamonds = 0,
    this.monthDiamonds = 0,
  });
  final int count;
  final int totalDiamonds;
  final int todayDiamonds;
  final int monthDiamonds;
  factory AgentSummary.fromJson(Json j) => AgentSummary(
    count: j.integer('count'),
    totalDiamonds: j.integer('totalDiamonds'),
    todayDiamonds: j.integer('todayDiamonds'),
    monthDiamonds: j.integer('monthDiamonds'),
  );
}

class LevelProgress {
  const LevelProgress({
    required this.level,
    required this.points,
    required this.currentLevelPoints,
    this.nextLevelPoints,
    required this.isMaxLevel,
  });
  final int level;
  final int points;
  final int currentLevelPoints;
  final int? nextLevelPoints;
  final bool isMaxLevel;

  double get fraction {
    final next = nextLevelPoints;
    if (isMaxLevel || next == null || next <= currentLevelPoints) return 1;
    return ((points - currentLevelPoints) / (next - currentLevelPoints))
        .clamp(0, 1)
        .toDouble();
  }

  factory LevelProgress.fromJson(Json j) => LevelProgress(
    level: j.integer('level'),
    points: j.integer('points'),
    currentLevelPoints: j.integer('currentLevelPoints'),
    nextLevelPoints: (j['nextLevelPoints'] as num?)?.toInt(),
    isMaxLevel: j.flag('isMaxLevel'),
  );
}

class Wallet {
  const Wallet({this.diamonds = 0, this.beans = 0, this.agentStock = 0});
  final int diamonds;
  final int beans;
  final int agentStock;
  factory Wallet.fromJson(Json j) => Wallet(
    diamonds: j.integer('diamonds'),
    beans: j.integer('beans'),
    agentStock: j.integer('agentStock'),
  );
}

class PublicUser {
  const PublicUser({
    required this.brief,
    required this.bio,
    required this.followers,
    required this.following,
    required this.isLive,
    this.liveRoomId,
    this.gender,
    this.agencyId,
    this.isFollowing = false,
    this.isBlocked = false,
  });

  final UserBrief brief;
  final String bio;
  final int followers;
  final int following;
  final bool isLive;
  final String? liveRoomId;
  final String? gender;
  final String? agencyId;
  final bool isFollowing;
  final bool isBlocked;

  String get id => brief.id;

  factory PublicUser.fromJson(Json j) => PublicUser(
    brief: UserBrief.fromJson(j),
    bio: j.str('bio'),
    followers: j.integer('followers'),
    following: j.integer('following'),
    isLive: j.flag('isLive'),
    liveRoomId: j.strOrNull('liveRoomId'),
    gender: j.strOrNull('gender'),
    agencyId: j.strOrNull('agencyId'),
    isFollowing: j.flag('isFollowing'),
    isBlocked: j.flag('isBlocked'),
  );
}

class MeUser {
  const MeUser({
    required this.profile,
    required this.wallet,
    required this.levelProgress,
    required this.isAgent,
    this.adminRole,
    this.email,
    this.phone,
    this.vipExpiresAt,
  });
  final PublicUser profile;
  final Wallet wallet;
  final LevelProgress levelProgress;
  final bool isAgent;
  final String? adminRole;
  final String? email;
  final String? phone;
  final DateTime? vipExpiresAt;

  String get id => profile.id;
  UserBrief get brief => profile.brief;

  MeUser withWallet(Wallet w) => MeUser(
    profile: profile,
    wallet: w,
    levelProgress: levelProgress,
    isAgent: isAgent,
    adminRole: adminRole,
    email: email,
    phone: phone,
    vipExpiresAt: vipExpiresAt,
  );

  MeUser withDiamonds(int diamonds) => withWallet(
    Wallet(
      diamonds: diamonds,
      beans: wallet.beans,
      agentStock: wallet.agentStock,
    ),
  );

  factory MeUser.fromJson(Json j) => MeUser(
    profile: PublicUser.fromJson(j),
    wallet: Wallet.fromJson(j.obj('wallet')),
    levelProgress: LevelProgress.fromJson(j.obj('levelProgress')),
    isAgent: j.flag('isAgent'),
    adminRole: j.strOrNull('adminRole'),
    email: j.strOrNull('email'),
    phone: j.strOrNull('phone'),
    vipExpiresAt: j.date('vipExpiresAt'),
  );
}

class LiveRoom {
  const LiveRoom({
    required this.id,
    required this.type,
    required this.status,
    required this.title,
    this.coverUrl,
    required this.host,
    required this.viewerCount,
    required this.giftBeans,
    this.pkBattleId,
    this.locked = false,
    this.hasPassword = false,
    required this.startedAt,
  });

  final String id;
  final String type;
  final String status;
  final String title;
  final String? coverUrl;
  final UserBrief host;
  final int viewerCount;
  final int giftBeans;
  final String? pkBattleId;

  /// No new viewers can join; [hasPassword] means the password still lets them in.
  final bool locked;
  final bool hasPassword;
  final DateTime? startedAt;

  bool get isAudio => type == 'audio';

  LiveRoom copyWith({
    String? title,
    String? coverUrl,
    int? viewerCount,
    int? giftBeans,
    String? Function()? pkBattleId,
    bool? locked,
    bool? hasPassword,
  }) => LiveRoom(
    id: id,
    type: type,
    status: status,
    title: title ?? this.title,
    coverUrl: coverUrl ?? this.coverUrl,
    host: host,
    viewerCount: viewerCount ?? this.viewerCount,
    giftBeans: giftBeans ?? this.giftBeans,
    pkBattleId: pkBattleId == null ? this.pkBattleId : pkBattleId(),
    locked: locked ?? this.locked,
    hasPassword: hasPassword ?? this.hasPassword,
    startedAt: startedAt,
  );

  factory LiveRoom.fromJson(Json j) => LiveRoom(
    id: j.str('id'),
    type: j.str('type', 'video'),
    status: j.str('status'),
    title: j.str('title'),
    coverUrl: j.strOrNull('coverUrl'),
    host: UserBrief.fromJson(j.obj('host')),
    viewerCount: j.integer('viewerCount'),
    giftBeans: j.integer('giftBeans'),
    pkBattleId: j.strOrNull('pkBattleId'),
    locked: j.flag('locked'),
    hasPassword: j.flag('hasPassword'),
    startedAt: j.date('startedAt'),
  );
}

class Seat {
  const Seat({
    required this.index,
    this.user,
    required this.muted,
    this.videoMuted = false,
    required this.locked,
  });
  final int index;
  final UserBrief? user;

  /// Mic / camera turned off by the host or a room admin.
  final bool muted;
  final bool videoMuted;
  final bool locked;

  factory Seat.fromJson(Json j) {
    final u = j.objOrNull('user');
    return Seat(
      index: j.integer('index'),
      user: u == null ? null : UserBrief.fromJson(u),
      muted: j.flag('muted'),
      videoMuted: j.flag('videoMuted'),
      locked: j.flag('locked'),
    );
  }
}

class RoomDetail {
  const RoomDetail({
    required this.room,
    required this.livekitRoom,
    required this.moderatorIds,
    this.moderators = const [],
    required this.seats,
    this.backgroundUrl,
    this.clockOffset = Duration.zero,
  });
  final LiveRoom room;
  final String livekitRoom;

  /// Room admins appointed by the host.
  final List<String> moderatorIds;
  final List<UserBrief> moderators;
  final List<Seat> seats;
  final String? backgroundUrl;

  /// Server − device clock, so the elapsed time is right on a phone whose clock is off.
  final Duration clockOffset;

  RoomDetail copyWith({
    LiveRoom? room,
    List<String>? moderatorIds,
    List<UserBrief>? moderators,
    List<Seat>? seats,
    String? Function()? backgroundUrl,
  }) => RoomDetail(
    room: room ?? this.room,
    livekitRoom: livekitRoom,
    moderatorIds: moderatorIds ?? this.moderatorIds,
    moderators: moderators ?? this.moderators,
    seats: seats ?? this.seats,
    backgroundUrl: backgroundUrl == null ? this.backgroundUrl : backgroundUrl(),
    clockOffset: clockOffset,
  );

  factory RoomDetail.fromJson(Json j) {
    final serverTime = j.date('serverTime');
    return RoomDetail(
      room: LiveRoom.fromJson(j),
      livekitRoom: j.str('livekitRoom'),
      moderatorIds: j.strings('moderatorIds'),
      moderators: j.list('moderators', UserBrief.fromJson),
      seats: j.list('seats', Seat.fromJson),
      backgroundUrl: j.strOrNull('backgroundUrl'),
      clockOffset: serverTime == null
          ? Duration.zero
          : serverTime.difference(DateTime.now()),
    );
  }
}

/// A viewer asking for a seat, as listed to the host and room admins.
class SeatRequest {
  const SeatRequest({required this.user, this.expiresAt});
  final UserBrief user;
  final DateTime? expiresAt;
  factory SeatRequest.fromJson(Json j) => SeatRequest(
    user: UserBrief.fromJson(j.obj('user')),
    expiresAt: j.date('expiresAt'),
  );
}

/// A live host the PK picker can challenge.
class PkCandidate {
  const PkCandidate({
    required this.user,
    required this.roomId,
    required this.viewerCount,
    required this.busy,
  });
  final UserBrief user;
  final String roomId;
  final int viewerCount;
  final bool busy;
  factory PkCandidate.fromJson(Json j) => PkCandidate(
    user: UserBrief.fromJson(j.obj('user')),
    roomId: j.str('roomId'),
    viewerCount: j.integer('viewerCount'),
    busy: j.flag('busy'),
  );
}

class LiveCredentials {
  const LiveCredentials({
    required this.token,
    required this.url,
    required this.identity,
    required this.role,
  });
  final String token;
  final String url;
  final String identity;
  final String role;

  bool get canPublish => role == 'host' || role == 'guest';

  factory LiveCredentials.fromJson(Json j) => LiveCredentials(
    token: j.str('token'),
    url: j.str('url'),
    identity: j.str('identity'),
    role: j.str('role', 'audience'),
  );
}

class LiveSession {
  const LiveSession({required this.detail, required this.credentials});
  final RoomDetail detail;
  final LiveCredentials credentials;
  factory LiveSession.fromJson(Json j) => LiveSession(
    detail: RoomDetail.fromJson(j.obj('room')),
    credentials: LiveCredentials.fromJson(j.obj('credentials')),
  );
}

class Gift {
  const Gift({
    required this.id,
    required this.name,
    required this.price,
    required this.iconUrl,
    this.animationUrl,
    required this.animationFormat,
    required this.category,
    required this.vipTierRequired,
  });
  final String id;
  final String name;
  final int price;
  final String iconUrl;
  final String? animationUrl;
  final String animationFormat;
  final String category;
  final int vipTierRequired;

  factory Gift.fromJson(Json j) => Gift(
    id: j.str('id'),
    name: j.str('name'),
    price: j.integer('price'),
    iconUrl: j.str('iconUrl'),
    animationUrl: j.strOrNull('animationUrl'),
    animationFormat: j.str('animationFormat', 'none'),
    category: j.str('category', 'popular'),
    vipTierRequired: j.integer('vipTierRequired'),
  );
}

class LedgerEntry {
  const LedgerEntry({
    required this.id,
    required this.currency,
    required this.delta,
    required this.balanceAfter,
    required this.reason,
    this.createdAt,
  });
  final String id;
  final String currency;
  final int delta;
  final int balanceAfter;
  final String reason;
  final DateTime? createdAt;

  String get label => reason.replaceAll('_', ' ');

  factory LedgerEntry.fromJson(Json j) => LedgerEntry(
    id: j.str('id'),
    currency: j.str('currency'),
    delta: j.integer('delta'),
    balanceAfter: j.integer('balanceAfter'),
    reason: j.str('reason'),
    createdAt: j.date('createdAt'),
  );
}

class RechargePackage {
  const RechargePackage({
    required this.sku,
    required this.diamonds,
    required this.bonusDiamonds,
    required this.priceUsd,
  });
  final String sku;
  final int diamonds;
  final int bonusDiamonds;
  final double priceUsd;
  factory RechargePackage.fromJson(Json j) => RechargePackage(
    sku: j.str('sku'),
    diamonds: j.integer('diamonds'),
    bonusDiamonds: j.integer('bonusDiamonds'),
    priceUsd: j.dbl('priceUsd'),
  );
}

class BannerItem {
  const BannerItem({
    required this.id,
    required this.title,
    required this.imageUrl,
    this.linkUrl,
  });
  final String id;
  final String title;
  final String imageUrl;
  final String? linkUrl;
  factory BannerItem.fromJson(Json j) => BannerItem(
    id: j.str('id'),
    title: j.str('title'),
    imageUrl: j.str('imageUrl'),
    linkUrl: j.strOrNull('linkUrl'),
  );
}

class Conversation {
  const Conversation({
    required this.id,
    this.peer,
    this.lastText,
    this.lastAt,
    required this.unread,
  });
  final String id;
  final UserBrief? peer;
  final String? lastText;
  final DateTime? lastAt;
  final int unread;

  factory Conversation.fromJson(Json j) {
    final peer = j.objOrNull('peer');
    final last = j.objOrNull('lastMessage');
    return Conversation(
      id: j.str('id'),
      peer: peer == null ? null : UserBrief.fromJson(peer),
      lastText: last?.strOrNull('text'),
      lastAt: last?.date('at'),
      unread: j.integer('unread'),
    );
  }
}

class ChatMessage {
  const ChatMessage({
    required this.id,
    required this.conversationId,
    required this.senderId,
    required this.type,
    this.text,
    this.mediaUrl,
    this.createdAt,
    this.pending = false,
  });
  final String id;
  final String conversationId;
  final String senderId;
  final String type;
  final String? text;
  final String? mediaUrl;
  final DateTime? createdAt;
  final bool pending;

  factory ChatMessage.fromJson(Json j) => ChatMessage(
    id: j.str('id'),
    conversationId: j.str('conversationId'),
    senderId: j.str('senderId'),
    type: j.str('type', 'text'),
    text: j.strOrNull('text'),
    mediaUrl: j.strOrNull('mediaUrl'),
    createdAt: j.date('createdAt'),
  );
}

class FeedPost {
  const FeedPost({
    required this.id,
    this.author,
    required this.text,
    required this.media,
    required this.likeCount,
    required this.commentCount,
    required this.likedByMe,
    this.createdAt,
  });
  final String id;
  final UserBrief? author;
  final String text;
  final List<String> media;
  final int likeCount;
  final int commentCount;
  final bool likedByMe;
  final DateTime? createdAt;

  FeedPost copyWith({int? likeCount, bool? likedByMe, int? commentCount}) =>
      FeedPost(
        id: id,
        author: author,
        text: text,
        media: media,
        likeCount: likeCount ?? this.likeCount,
        commentCount: commentCount ?? this.commentCount,
        likedByMe: likedByMe ?? this.likedByMe,
        createdAt: createdAt,
      );

  factory FeedPost.fromJson(Json j) {
    final author = j.objOrNull('author');
    return FeedPost(
      id: j.str('id'),
      author: author == null ? null : UserBrief.fromJson(author),
      text: j.str('text'),
      media: j.list('media', (m) => m.str('url')),
      likeCount: j.integer('likeCount'),
      commentCount: j.integer('commentCount'),
      likedByMe: j.flag('likedByMe'),
      createdAt: j.date('createdAt'),
    );
  }
}

class FeedComment {
  const FeedComment({
    required this.id,
    this.author,
    required this.text,
    this.createdAt,
  });
  final String id;
  final UserBrief? author;
  final String text;
  final DateTime? createdAt;
  factory FeedComment.fromJson(Json j) {
    final a = j.objOrNull('author');
    return FeedComment(
      id: j.str('id'),
      author: a == null ? null : UserBrief.fromJson(a),
      text: j.str('text'),
      createdAt: j.date('createdAt'),
    );
  }
}

class AppNotification {
  const AppNotification({
    required this.id,
    required this.type,
    required this.title,
    required this.body,
    required this.data,
    required this.read,
    this.createdAt,
  });
  final String id;
  final String type;
  final String title;
  final String body;
  final Map<String, dynamic> data;
  final bool read;
  final DateTime? createdAt;
  factory AppNotification.fromJson(Json j) => AppNotification(
    id: j.str('id'),
    type: j.str('type'),
    title: j.str('title'),
    body: j.str('body'),
    data: j.obj('data'),
    read: j.flag('read'),
    createdAt: j.date('createdAt'),
  );
}

class VipPackage {
  const VipPackage({
    required this.id,
    required this.tier,
    required this.name,
    required this.priceDiamonds,
    required this.durationDays,
    required this.perks,
    this.frameUrl,
    this.frameFormat = 'none',
  });
  final String id;
  final int tier;
  final String name;
  final int priceDiamonds;
  final int durationDays;
  final List<String> perks;

  /// The avatar frame members of this tier wear.
  final String? frameUrl;
  final String frameFormat;
  factory VipPackage.fromJson(Json j) => VipPackage(
    id: j.str('_id', j.str('id')),
    tier: j.integer('tier'),
    name: j.str('name'),
    priceDiamonds: j.integer('priceDiamonds'),
    durationDays: j.integer('durationDays'),
    perks: j.strings('perks'),
    frameUrl: j.strOrNull('frameUrl'),
    frameFormat: j.str('frameFormat', 'none'),
  );
}

class StoreItem {
  const StoreItem({
    required this.id,
    required this.type,
    required this.name,
    required this.assetUrl,
    this.previewUrl,
    required this.priceDiamonds,
    required this.durationDays,
    required this.vipTierRequired,
    this.animationFormat = 'none',
  });
  final String id;
  final String type;
  final String name;
  final String assetUrl;
  final String? previewUrl;
  final int priceDiamonds;
  final int durationDays;
  final int vipTierRequired;
  final String animationFormat;
  factory StoreItem.fromJson(Json j) => StoreItem(
    id: j.str('id'),
    type: j.str('type'),
    name: j.str('name'),
    assetUrl: j.str('assetUrl'),
    previewUrl: j.strOrNull('previewUrl'),
    animationFormat: j.str('animationFormat', 'none'),
    priceDiamonds: j.integer('priceDiamonds'),
    durationDays: j.integer('durationDays'),
    vipTierRequired: j.integer('vipTierRequired'),
  );
}

class GameInfo {
  const GameInfo({
    required this.key,
    required this.name,
    required this.url,
    this.iconUrl,
  });
  final String key;
  final String name;
  final String url;
  final String? iconUrl;
  factory GameInfo.fromJson(Json j) => GameInfo(
    key: j.str('key'),
    name: j.str('name'),
    url: j.str('url'),
    iconUrl: j.strOrNull('iconUrl'),
  );
}

class PkHost {
  const PkHost({
    required this.uid,
    required this.roomId,
    required this.score,
    this.roundScore = 0,
    this.roundsWon = 0,
    required this.displayName,
    this.avatarUrl,
    this.level = 0,
    this.vipTier = 0,
    this.frameUrl,
    this.frameFormat = 'none',
  });
  final String uid;
  final String roomId;

  /// Total over the battle; [roundScore] is the current (or last) round.
  final int score;
  final int roundScore;
  final int roundsWon;
  final String displayName;
  final String? avatarUrl;
  final int level;
  final int vipTier;
  final String? frameUrl;
  final String frameFormat;

  /// The host as a [UserBrief], for avatar and badge widgets.
  UserBrief get brief => UserBrief(
    id: uid,
    shortId: '',
    displayName: displayName,
    avatarUrl: avatarUrl,
    level: level,
    vipTier: vipTier,
    frameUrl: frameUrl,
    frameFormat: frameFormat,
  );

  factory PkHost.fromJson(Json j) => PkHost(
    uid: j.str('uid'),
    roomId: j.str('roomId'),
    score: j.integer('score'),
    roundScore: j.integer('roundScore', j.integer('score')),
    roundsWon: j.integer('roundsWon'),
    displayName: j.str('displayName'),
    avatarUrl: j.strOrNull('avatarUrl'),
    level: j.integer('level'),
    vipTier: j.integer('vipTier'),
    frameUrl: j.strOrNull('frameUrl'),
    frameFormat: j.str('frameFormat', 'none'),
  );
}

class PkRound {
  const PkRound({required this.round, required this.scores, this.winnerUid});
  final int round;
  final List<int> scores;
  final String? winnerUid;
  factory PkRound.fromJson(Json j) => PkRound(
    round: j.integer('round'),
    scores: ((j['scores'] as List<dynamic>?) ?? const [])
        .whereType<num>()
        .map((n) => n.toInt())
        .toList(),
    winnerUid: j.strOrNull('winnerUid'),
  );
}

/// A PK battle as the server last described it. Deadlines are server instants; the
/// [clockOffset] (server − device) converts them to device time for countdowns.
class PkBattle {
  const PkBattle({
    required this.id,
    required this.status,
    required this.hosts,
    this.invitedBy = '',
    required this.durationSec,
    this.round = 1,
    this.maxRounds = 1,
    this.roundState,
    this.scoringOpensAt,
    this.endsAt,
    this.pausedUntil,
    this.rounds = const [],
    this.inviteExpiresAt,
    this.winnerUid,
    required this.isDraw,
    this.endReason,
    this.clockOffset = Duration.zero,
  });
  final String id;
  final String status;
  final List<PkHost> hosts;
  final String invitedBy;
  final int durationSec;
  final int round;
  final int maxRounds;

  /// `live` while a round is scored, `paused` between rounds.
  final String? roundState;
  final DateTime? scoringOpensAt;
  final DateTime? endsAt;
  final DateTime? pausedUntil;
  final List<PkRound> rounds;
  final DateTime? inviteExpiresAt;
  final String? winnerUid;
  final bool isDraw;
  final String? endReason;
  final Duration clockOffset;

  bool get isActive => status == 'active';
  bool get isEnded => status == 'ended';
  bool get isPaused => isActive && roundState == 'paused';

  /// Server "now", estimated from the device clock.
  DateTime get serverNow => DateTime.now().add(clockOffset);

  PkHost? host(String uid) => hosts.where((h) => h.uid == uid).firstOrNull;

  factory PkBattle.fromJson(Json j) {
    final serverTime = j.date('serverTime');
    return PkBattle(
      id: j.str('id'),
      status: j.str('status'),
      hosts: j.list('hosts', PkHost.fromJson),
      invitedBy: j.str('invitedBy'),
      durationSec: j.integer('durationSec'),
      round: j.integer('round', 1),
      maxRounds: j.integer('maxRounds', 1),
      roundState: j.strOrNull('roundState'),
      scoringOpensAt: j.date('scoringOpensAt'),
      endsAt: j.date('endsAt'),
      pausedUntil: j.date('pausedUntil'),
      rounds: j.list('rounds', PkRound.fromJson),
      inviteExpiresAt: j.date('inviteExpiresAt'),
      winnerUid: j.strOrNull('winnerUid'),
      isDraw: j.flag('isDraw'),
      endReason: j.strOrNull('endReason'),
      clockOffset: serverTime == null
          ? Duration.zero
          : serverTime.difference(DateTime.now()),
    );
  }
}

class LeaderboardEntry {
  const LeaderboardEntry({
    required this.rank,
    this.user,
    required this.diamonds,
  });
  final int rank;
  final UserBrief? user;
  final int diamonds;
  factory LeaderboardEntry.fromJson(Json j) {
    final u = j.objOrNull('user');
    return LeaderboardEntry(
      rank: j.integer('rank'),
      user: u == null ? null : UserBrief.fromJson(u),
      diamonds: j.integer('diamonds'),
    );
  }
}

class AppConfig {
  const AppConfig({
    required this.maintenance,
    required this.maintenanceMessage,
    required this.minBuildAndroid,
    required this.minBuildIos,
    required this.features,
    required this.pkDurations,
    required this.termsUrl,
    required this.privacyUrl,
    required this.supportEmail,
  });
  final bool maintenance;
  final String maintenanceMessage;
  final int minBuildAndroid;
  final int minBuildIos;
  final Map<String, bool> features;
  final List<int> pkDurations;
  final String termsUrl;
  final String privacyUrl;
  final String supportEmail;

  bool feature(String key) => features[key] ?? true;

  factory AppConfig.fromJson(Json j) {
    final app = j.obj('app');
    final min = app.obj('minSupportedBuild');
    return AppConfig(
      maintenance: app.flag('maintenance'),
      maintenanceMessage: app.str('maintenanceMessage'),
      minBuildAndroid: min.integer('android'),
      minBuildIos: min.integer('ios'),
      features: j.obj('features').map((k, v) => MapEntry(k, v == true)),
      pkDurations:
          ((j.obj('pk')['durationsSec'] as List<dynamic>?) ??
                  const [180, 300, 600])
              .whereType<num>()
              .map((n) => n.toInt())
              .toList(),
      termsUrl: app.str('termsUrl'),
      privacyUrl: app.str('privacyUrl'),
      supportEmail: app.str('supportEmail'),
    );
  }
}

// ── Host agencies ───────────────────────────────────────────────────────────

UserBrief? _briefOrNull(Json j, String key) =>
    j.objOrNull(key) == null ? null : UserBrief.fromJson(j.obj(key));

class AgencySummary {
  const AgencySummary({
    required this.id,
    required this.code,
    required this.name,
    this.logoUrl,
    this.memberCount = 0,
  });
  final String id;

  /// Public agency code, `HA-XXXXXXXX`.
  final String code;
  final String name;
  final String? logoUrl;
  final int memberCount;
  factory AgencySummary.fromJson(Json j) => AgencySummary(
    id: j.str('id'),
    code: j.str('code'),
    name: j.str('name'),
    logoUrl: j.strOrNull('logoUrl'),
    memberCount: j.integer('memberCount'),
  );
}

/// A card in the home "Top agencies" slider.
class TopAgency {
  const TopAgency({
    required this.agency,
    required this.rank,
    required this.periodBeans,
  });
  final AgencySummary agency;
  final int rank;
  final int periodBeans;
  factory TopAgency.fromJson(Json j) => TopAgency(
    agency: AgencySummary.fromJson(j),
    rank: j.integer('rank'),
    periodBeans: j.integer('periodBeans'),
  );
}

class AgencyMember {
  const AgencyMember({
    this.user,
    this.role = 'host',
    this.locked = false,
    this.dailyTargetMinutes,
    this.joinedAt,
    this.periodBeans = 0,
    this.periodLiveSeconds = 0,
    this.lifetimeBeans = 0,
    this.lifetimeLiveSeconds = 0,
    this.todayBeans = 0,
    this.todayLiveSeconds = 0,
    this.isLive = false,
  });
  final UserBrief? user;

  /// `host` or `admin` (agency admin).
  final String role;
  final bool locked;
  final int? dailyTargetMinutes;
  final DateTime? joinedAt;
  final int periodBeans;
  final int periodLiveSeconds;
  final int lifetimeBeans;
  final int lifetimeLiveSeconds;
  final int todayBeans;
  final int todayLiveSeconds;
  final bool isLive;

  bool get isAdmin => role == 'admin';

  /// Today's progress towards the daily target, 0–1; null when there is no target.
  double? get targetProgress {
    final t = dailyTargetMinutes;
    if (t == null || t <= 0) return null;
    return (todayLiveSeconds / (t * 60)).clamp(0, 1).toDouble();
  }

  factory AgencyMember.fromJson(Json j) => AgencyMember(
    user: _briefOrNull(j, 'user'),
    role: j.str('role', 'host'),
    locked: j.flag('locked'),
    dailyTargetMinutes: (j['dailyTargetMinutes'] as num?)?.toInt(),
    joinedAt: j.date('joinedAt'),
    periodBeans: j.integer('periodBeans'),
    periodLiveSeconds: j.integer('periodLiveSeconds'),
    lifetimeBeans: j.integer('lifetimeBeans'),
    lifetimeLiveSeconds: j.integer('lifetimeLiveSeconds'),
    todayBeans: j.integer('todayBeans'),
    todayLiveSeconds: j.integer('todayLiveSeconds'),
    isLive: j.flag('isLive'),
  );
}

class AgencyDashboard {
  const AgencyDashboard({
    required this.agency,
    required this.ownerId,
    required this.commissionRate,
    required this.status,
    required this.role,
    this.rank,
    required this.periodKey,
    required this.totals,
    this.pendingRequests = 0,
    this.pendingInvitations = 0,
  });
  final AgencySummary agency;
  final String ownerId;
  final double commissionRate;
  final String status;

  /// The caller's role: `owner` or `admin`.
  final String role;
  final int? rank;
  final String periodKey;
  final Json totals;
  final int pendingRequests;
  final int pendingInvitations;

  bool get isOwner => role == 'owner';
  bool get suspended => status != 'active';
  int total(String key) => totals.integer(key);

  factory AgencyDashboard.fromJson(Json j) {
    final a = j.obj('agency');
    return AgencyDashboard(
      agency: AgencySummary.fromJson(a),
      ownerId: a.str('ownerId'),
      commissionRate: a.dbl('commissionRate'),
      status: a.str('status', 'active'),
      role: j.str('role', 'owner'),
      rank: (j['rank'] as num?)?.toInt(),
      periodKey: j.str('periodKey'),
      totals: j.obj('totals'),
      pendingRequests: j.integer('pendingRequests'),
      pendingInvitations: j.integer('pendingInvitations'),
    );
  }
}

class AgencyDay {
  const AgencyDay({
    required this.dayKey,
    this.beans = 0,
    this.gifts = 0,
    this.commission = 0,
    this.liveSeconds = 0,
    this.activeHosts,
  });
  final String dayKey;
  final int beans;
  final int gifts;
  final int commission;
  final int liveSeconds;
  final int? activeHosts;
  factory AgencyDay.fromJson(Json j) => AgencyDay(
    dayKey: j.str('dayKey'),
    beans: j.integer('beans'),
    gifts: j.integer('gifts'),
    commission: j.integer('commission'),
    liveSeconds: j.integer('liveSeconds'),
    activeHosts: (j['activeHosts'] as num?)?.toInt(),
  );
}

class AgencyAnalytics {
  const AgencyAnalytics({
    required this.days,
    required this.totals,
    required this.daily,
    this.member,
    this.sessions,
  });
  final int days;
  final AgencyDay totals;

  /// Oldest first, one per day.
  final List<AgencyDay> daily;

  /// Set for a single host's analytics.
  final AgencyMember? member;
  final int? sessions;
  factory AgencyAnalytics.fromJson(Json j) => AgencyAnalytics(
    days: j.integer('days'),
    totals: AgencyDay.fromJson({...j.obj('totals'), 'dayKey': ''}),
    daily: j.list('daily', AgencyDay.fromJson),
    member: j.objOrNull('member') == null
        ? null
        : AgencyMember.fromJson(j.obj('member')),
    sessions: (j['sessions'] as num?)?.toInt(),
  );
}

class AgencyGiftRow {
  const AgencyGiftRow({
    required this.id,
    this.sender,
    required this.giftName,
    required this.quantity,
    required this.cost,
    required this.beans,
    this.createdAt,
  });
  final String id;
  final UserBrief? sender;
  final String giftName;
  final int quantity;
  final int cost;
  final int beans;
  final DateTime? createdAt;
  factory AgencyGiftRow.fromJson(Json j) => AgencyGiftRow(
    id: j.str('id'),
    sender: _briefOrNull(j, 'sender'),
    giftName: j.str('giftName'),
    quantity: j.integer('quantity', 1),
    cost: j.integer('cost'),
    beans: j.integer('beans'),
    createdAt: j.date('createdAt'),
  );
}

class AgencySessionRow {
  const AgencySessionRow({
    required this.id,
    required this.type,
    required this.title,
    this.startedAt,
    this.endedAt,
    required this.durationSec,
    required this.giftBeans,
    required this.peakViewers,
  });
  final String id;
  final String type;
  final String title;
  final DateTime? startedAt;
  final DateTime? endedAt;
  final int durationSec;
  final int giftBeans;
  final int peakViewers;
  factory AgencySessionRow.fromJson(Json j) => AgencySessionRow(
    id: j.str('id'),
    type: j.str('type', 'video'),
    title: j.str('title'),
    startedAt: j.date('startedAt'),
    endedAt: j.date('endedAt'),
    durationSec: j.integer('durationSec'),
    giftBeans: j.integer('giftBeans'),
    peakViewers: j.integer('peakViewers'),
  );
}

class AgencyLeaderboard {
  const AgencyLeaderboard({
    required this.periodKey,
    required this.periods,
    required this.items,
  });
  final String periodKey;
  final List<String> periods;
  final List<({int rank, UserBrief? user, int beans, int liveSeconds})> items;
  factory AgencyLeaderboard.fromJson(Json j) => AgencyLeaderboard(
    periodKey: j.str('periodKey'),
    periods: j.strings('periods'),
    items: j.list(
      'items',
      (r) => (
        rank: r.integer('rank'),
        user: _briefOrNull(r, 'user'),
        beans: r.integer('beans'),
        liveSeconds: r.integer('liveSeconds'),
      ),
    ),
  );
}

class AgencyInvitation {
  const AgencyInvitation({
    required this.id,
    required this.agency,
    this.user,
    this.invitedBy,
    this.createdAt,
    this.expiresAt,
  });
  final String id;
  final AgencySummary agency;
  final UserBrief? user;
  final UserBrief? invitedBy;
  final DateTime? createdAt;
  final DateTime? expiresAt;
  factory AgencyInvitation.fromJson(Json j) => AgencyInvitation(
    id: j.str('id'),
    agency: AgencySummary.fromJson(j.obj('agency')),
    user: _briefOrNull(j, 'user'),
    invitedBy: _briefOrNull(j, 'invitedBy'),
    createdAt: j.date('createdAt'),
    expiresAt: j.date('expiresAt'),
  );
}

class AgencyRequest {
  const AgencyRequest({required this.id, this.user, this.createdAt});
  final String id;
  final UserBrief? user;
  final DateTime? createdAt;
  factory AgencyRequest.fromJson(Json j) => AgencyRequest(
    id: j.str('id'),
    user: _briefOrNull(j, 'user'),
    createdAt: j.date('createdAt'),
  );
}

class AgencyAuditRow {
  const AgencyAuditRow({
    required this.id,
    required this.action,
    this.actor,
    this.target,
    this.meta = const {},
    this.createdAt,
  });
  final String id;
  final String action;
  final UserBrief? actor;
  final UserBrief? target;
  final Json meta;
  final DateTime? createdAt;
  factory AgencyAuditRow.fromJson(Json j) => AgencyAuditRow(
    id: j.str('id'),
    action: j.str('action'),
    actor: _briefOrNull(j, 'actor'),
    target: _briefOrNull(j, 'target'),
    meta: j.obj('meta'),
    createdAt: j.date('createdAt'),
  );
}

class AgencyMembership {
  const AgencyMembership({
    required this.agency,
    this.role = 'host',
    this.locked = false,
    this.joinedAt,
  });
  final AgencySummary agency;
  final String role;
  final bool locked;
  final DateTime? joinedAt;
  factory AgencyMembership.fromJson(Json j) => AgencyMembership(
    agency: AgencySummary.fromJson(j.obj('agency')),
    role: j.str('role', 'host'),
    locked: j.flag('locked'),
    joinedAt: j.date('joinedAt'),
  );
}
