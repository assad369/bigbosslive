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
  });

  final String id;
  final String shortId;
  final String displayName;
  final String? avatarUrl;
  final int level;
  final int vipTier;
  final String? country;
  final String? frameUrl;

  factory UserBrief.fromJson(Json j) => UserBrief(
    id: j.str('id', j.str('uid')),
    shortId: j.str('shortId'),
    displayName: j.str('displayName', 'User'),
    avatarUrl: j.strOrNull('avatarUrl'),
    level: j.integer('level'),
    vipTier: j.integer('vipTier'),
    country: j.strOrNull('country'),
    frameUrl: j.strOrNull('frameUrl'),
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
  final DateTime? startedAt;

  bool get isAudio => type == 'audio';

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
    startedAt: j.date('startedAt'),
  );
}

class Seat {
  const Seat({
    required this.index,
    this.user,
    required this.muted,
    required this.locked,
  });
  final int index;
  final UserBrief? user;
  final bool muted;
  final bool locked;

  factory Seat.fromJson(Json j) {
    final u = j.objOrNull('user');
    return Seat(
      index: j.integer('index'),
      user: u == null ? null : UserBrief.fromJson(u),
      muted: j.flag('muted'),
      locked: j.flag('locked'),
    );
  }
}

class RoomDetail {
  const RoomDetail({
    required this.room,
    required this.livekitRoom,
    required this.moderatorIds,
    required this.seats,
    this.backgroundUrl,
  });
  final LiveRoom room;
  final String livekitRoom;
  final List<String> moderatorIds;
  final List<Seat> seats;
  final String? backgroundUrl;

  factory RoomDetail.fromJson(Json j) => RoomDetail(
    room: LiveRoom.fromJson(j),
    livekitRoom: j.str('livekitRoom'),
    moderatorIds: j.strings('moderatorIds'),
    seats: j.list('seats', Seat.fromJson),
    backgroundUrl: j.strOrNull('backgroundUrl'),
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
  });
  final String id;
  final int tier;
  final String name;
  final int priceDiamonds;
  final int durationDays;
  final List<String> perks;
  factory VipPackage.fromJson(Json j) => VipPackage(
    id: j.str('_id', j.str('id')),
    tier: j.integer('tier'),
    name: j.str('name'),
    priceDiamonds: j.integer('priceDiamonds'),
    durationDays: j.integer('durationDays'),
    perks: j.strings('perks'),
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
  });
  final String id;
  final String type;
  final String name;
  final String assetUrl;
  final String? previewUrl;
  final int priceDiamonds;
  final int durationDays;
  final int vipTierRequired;
  factory StoreItem.fromJson(Json j) => StoreItem(
    id: j.str('id'),
    type: j.str('type'),
    name: j.str('name'),
    assetUrl: j.str('assetUrl'),
    previewUrl: j.strOrNull('previewUrl'),
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
    required this.displayName,
    this.avatarUrl,
  });
  final String uid;
  final String roomId;
  final int score;
  final String displayName;
  final String? avatarUrl;
  factory PkHost.fromJson(Json j) => PkHost(
    uid: j.str('uid'),
    roomId: j.str('roomId'),
    score: j.integer('score'),
    displayName: j.str('displayName'),
    avatarUrl: j.strOrNull('avatarUrl'),
  );
}

class PkBattle {
  const PkBattle({
    required this.id,
    required this.status,
    required this.hosts,
    required this.durationSec,
    this.endsAt,
    this.winnerUid,
    required this.isDraw,
  });
  final String id;
  final String status;
  final List<PkHost> hosts;
  final int durationSec;
  final DateTime? endsAt;
  final String? winnerUid;
  final bool isDraw;

  bool get isActive => status == 'active';

  factory PkBattle.fromJson(Json j) => PkBattle(
    id: j.str('id'),
    status: j.str('status'),
    hosts: j.list('hosts', PkHost.fromJson),
    durationSec: j.integer('durationSec'),
    endsAt: j.date('endsAt'),
    winnerUid: j.strOrNull('winnerUid'),
    isDraw: j.flag('isDraw'),
  );
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
