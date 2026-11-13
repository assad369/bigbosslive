import '../core/utils/json.dart';
import 'youtube.dart';

export 'youtube.dart';

/// Artwork of a tier package, drawn as a badge at the bottom-right of the avatar. Up to
/// three renditions of the same picture; [TierBadgeView] plays MP4, else SVGA, else the image.
class TierBadge {
  const TierBadge({
    this.imageUrl,
    this.svgaUrl,
    this.mp4Url,
    this.additive = false,
  });

  final String? imageUrl;
  final String? svgaUrl;
  final String? mp4Url;

  /// The MP4 was exported on black: key black to transparent.
  final bool additive;

  bool get isEmpty => imageUrl == null && svgaUrl == null && mp4Url == null;

  /// Null when [j] is absent or carries no rendition, so "has a badge" is a null check.
  static TierBadge? fromJsonOrNull(Json? j) {
    if (j == null) return null;
    final b = TierBadge(
      imageUrl: j.strOrNull('imageUrl'),
      svgaUrl: j.strOrNull('svgaUrl'),
      mp4Url: j.strOrNull('mp4Url'),
      additive: j.str('blendMode') == 'additive',
    );
    return b.isEmpty ? null : b;
  }

  @override
  bool operator ==(Object other) =>
      other is TierBadge &&
      other.imageUrl == imageUrl &&
      other.svgaUrl == svgaUrl &&
      other.mp4Url == mp4Url &&
      other.additive == additive;

  @override
  int get hashCode => Object.hash(imageUrl, svgaUrl, mp4Url, additive);
}

/// Compact identity used in rooms, chat, leaderboards and lists.
class UserBrief {
  const UserBrief({
    required this.id,
    required this.shortId,
    required this.displayName,
    this.avatarUrl,
    this.level = 0,
    this.vipTier = 0,
    this.badge,
    this.country,
    this.frameUrl,
    this.frameFormat = 'none',
  });

  final String id;
  final String shortId;
  final String displayName;
  final String? avatarUrl;
  final int level;

  /// 0 none, 1 VIP, 2 VVIP, 3 Crown, 4 King (see `VipTier`).
  final int vipTier;

  /// The worn tier package's badge; null without an active tier.
  final TierBadge? badge;
  final String? country;

  /// Equipped avatar frame (the ring); tiers carry no frame of their own.
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
    badge: TierBadge.fromJsonOrNull(j.objOrNull('badge')),
    country: j.strOrNull('country'),
    frameUrl: j.strOrNull('frameUrl'),
    frameFormat: j.str('frameFormat', 'none'),
  );

  UserBrief copyWith({int? level}) => UserBrief(
    id: id,
    shortId: shortId,
    displayName: displayName,
    avatarUrl: avatarUrl,
    level: level ?? this.level,
    vipTier: vipTier,
    badge: badge,
    country: country,
    frameUrl: frameUrl,
    frameFormat: frameFormat,
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

/// Diamonds the platform added to an agent's own stock.
class AgentStockTopup {
  const AgentStockTopup({
    required this.id,
    required this.diamonds,
    required this.stockAfter,
    this.createdAt,
  });
  final String id;
  final int diamonds;

  /// The agent's stock right after this top-up.
  final int stockAfter;
  final DateTime? createdAt;
  factory AgentStockTopup.fromJson(Json j) => AgentStockTopup(
    id: j.str('id'),
    diamonds: j.integer('diamonds'),
    stockAfter: j.integer('stockAfter'),
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

/// Diamonds are the only user currency; agent stock is an agent's resale inventory.
class Wallet {
  const Wallet({this.diamonds = 0, this.agentStock = 0});
  final int diamonds;
  final int agentStock;
  factory Wallet.fromJson(Json j) => Wallet(
    diamonds: j.integer('diamonds'),
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
    this.diamonds,
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

  /// Current wallet balance, sent with a profile (`GET /users/:uid`); null in lists and
  /// from older servers.
  final int? diamonds;

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
    diamonds: j['diamonds'] is num ? j.integer('diamonds') : null,
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
    this.maintenanceAccess = false,
    this.moderation,
  });
  final PublicUser profile;
  final Wallet wallet;
  final LevelProgress levelProgress;
  final bool isAgent;
  final String? adminRole;
  final String? email;
  final String? phone;
  final DateTime? vipExpiresAt;

  /// On the admin's maintenance list: keeps using the app while maintenance mode is on.
  final bool maintenanceAccess;

  /// What this user may moderate from the app; null for everyone else.
  final MeModeration? moderation;

  /// Opens the Moderation panel (holds the platform moderator role).
  bool get isPlatformModerator => moderation?.isPlatformModerator ?? false;

  /// May remove, ban, mute and delete chat in any live, and end any live.
  bool get canModerateLive => moderation?.canModerateLive ?? false;

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
    maintenanceAccess: maintenanceAccess,
    moderation: moderation,
  );

  /// The server said this account is no longer on the maintenance list.
  MeUser withoutMaintenanceAccess() => MeUser(
    profile: profile,
    wallet: wallet,
    levelProgress: levelProgress,
    isAgent: isAgent,
    adminRole: adminRole,
    email: email,
    phone: phone,
    vipExpiresAt: vipExpiresAt,
    moderation: moderation,
  );

  MeUser withDiamonds(int diamonds) =>
      withWallet(Wallet(diamonds: diamonds, agentStock: wallet.agentStock));

  factory MeUser.fromJson(Json j) => MeUser(
    profile: PublicUser.fromJson(j),
    wallet: Wallet.fromJson(j.obj('wallet')),
    levelProgress: LevelProgress.fromJson(j.obj('levelProgress')),
    isAgent: j.flag('isAgent'),
    adminRole: j.strOrNull('adminRole'),
    email: j.strOrNull('email'),
    phone: j.strOrNull('phone'),
    vipExpiresAt: j.date('vipExpiresAt'),
    maintenanceAccess: j.flag('maintenanceAccess'),
    moderation: switch (j.objOrNull('moderation')) {
      final m? => MeModeration.fromJson(m),
      null => null,
    },
  );
}

/// In-app moderation rights (`/me.moderation`). The server enforces every one of them; the
/// app only uses this to decide what to draw.
class MeModeration {
  const MeModeration({
    this.isPlatformModerator = false,
    this.canModerateLive = false,
    this.stealthEnabled = false,
    this.selfStageEnabled = false,
  });

  /// Holds the platform moderator role: opens the Moderation panel.
  final bool isPlatformModerator;

  /// May remove, ban, mute and delete chat in any live, and end any live.
  final bool canModerateLive;

  /// Joins lives hidden (no viewer count, join line or entrance).
  final bool stealthEnabled;

  /// May take a free seat without the host's approval.
  final bool selfStageEnabled;

  factory MeModeration.fromJson(Json j) => MeModeration(
    isPlatformModerator: j.flag('isPlatformModerator'),
    canModerateLive: j.flag('canModerateLive'),
    stealthEnabled: j.flag('stealthEnabled'),
    selfStageEnabled: j.flag('selfStageEnabled'),
  );
}

/// A row of the Moderation panel's user search.
class ModeratedUser {
  const ModeratedUser({
    required this.user,
    required this.status,
    this.banReason,
    this.bannedUntil,
    this.bannedAt,
    this.isPlatformModerator = false,
    this.isAgent = false,
    this.isStaff = false,
    this.createdAt,
  });
  final UserBrief user;
  final String status;
  final String? banReason;

  /// Null on a permanent ban (or when not banned).
  final DateTime? bannedUntil;
  final DateTime? bannedAt;
  final bool isPlatformModerator;
  final bool isAgent;

  /// Dashboard staff. Platform moderators can't act on them.
  final bool isStaff;
  final DateTime? createdAt;

  String get id => user.id;
  bool get isBanned => status == 'banned';

  /// Only staff may act on staff and platform moderators; the server says so too.
  bool get isProtected => isStaff || isPlatformModerator;

  factory ModeratedUser.fromJson(Json j) {
    final ban = j.objOrNull('ban');
    return ModeratedUser(
      user: UserBrief.fromJson(j.obj('user')),
      status: j.str('status', 'active'),
      banReason: ban?.strOrNull('reason'),
      bannedUntil: ban?.date('until'),
      bannedAt: ban?.date('at'),
      isPlatformModerator: j.flag('isPlatformModerator'),
      isAgent: j.flag('isAgent'),
      isStaff: j.flag('isStaff'),
      createdAt: j.date('createdAt'),
    );
  }
}

/// A device an account signed in from.
class ModeratedDevice {
  const ModeratedDevice({
    required this.deviceId,
    this.platform,
    this.lastSeenAt,
    this.accountCount = 1,
    this.banned = false,
    this.isYours = false,
  });
  final String deviceId;
  final String? platform;
  final DateTime? lastSeenAt;
  final int accountCount;
  final bool banned;

  /// The moderator's own handset: it can't be banned from here.
  final bool isYours;

  factory ModeratedDevice.fromJson(Json j) => ModeratedDevice(
    deviceId: j.str('deviceId'),
    platform: j.strOrNull('platform'),
    lastSeenAt: j.date('lastSeenAt'),
    accountCount: j.integer('accountCount', 1),
    banned: j.flag('banned'),
    isYours: j.flag('isYours'),
  );
}

/// An account a device ban would leave alone, and why.
class SkippedAccount {
  const SkippedAccount({required this.uid, required this.reason, this.user});
  final String uid;
  final String reason;
  final UserBrief? user;

  factory SkippedAccount.fromJson(Json j) => SkippedAccount(
    uid: j.str('uid'),
    reason: j.str('reason'),
    user: switch (j.objOrNull('user')) {
      final u? => UserBrief.fromJson(u),
      null => null,
    },
  );
}

/// What banning every device of an account would do. Nothing is written until confirmed.
class DeviceBanPreview {
  const DeviceBanPreview({
    required this.devices,
    required this.accounts,
    this.alreadyBanned = 0,
    this.skipped = const [],
  });
  final int devices;

  /// Accounts that would be banned, the target included.
  final int accounts;
  final int alreadyBanned;
  final List<SkippedAccount> skipped;

  factory DeviceBanPreview.fromJson(Json j) => DeviceBanPreview(
    devices: j.integer('devices'),
    accounts: j.integer('accounts'),
    alreadyBanned: j.integer('alreadyBanned'),
    skipped: j.list('skipped', SkippedAccount.fromJson),
  );
}

class DeviceBanResult {
  const DeviceBanResult({
    this.devicesBanned = 0,
    this.accountsBanned = 0,
    this.skipped = const [],
  });
  final int devicesBanned;
  final int accountsBanned;
  final List<SkippedAccount> skipped;

  factory DeviceBanResult.fromJson(Json j) => DeviceBanResult(
    devicesBanned: j.integer('devicesBanned'),
    accountsBanned: j.integer('accountsBanned'),
    skipped: j.list('skipped', SkippedAccount.fromJson),
  );
}

/// A host who banned a user from their lives.
class ModeratedRoomBan {
  const ModeratedRoomBan({
    required this.hostId,
    this.host,
    this.until,
    this.createdAt,
  });
  final String hostId;
  final UserBrief? host;

  /// Null = until lifted.
  final DateTime? until;
  final DateTime? createdAt;

  factory ModeratedRoomBan.fromJson(Json j) => ModeratedRoomBan(
    hostId: j.str('hostId'),
    host: switch (j.objOrNull('host')) {
      final h? => UserBrief.fromJson(h),
      null => null,
    },
    until: j.date('until'),
    createdAt: j.date('createdAt'),
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
    required this.giftDiamonds,
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
  final int giftDiamonds;
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
    int? giftDiamonds,
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
    giftDiamonds: giftDiamonds ?? this.giftDiamonds,
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
    giftDiamonds: j.integer('giftDiamonds'),
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
    this.diamonds = 0,
    this.seatedAt,
  });
  final int index;
  final UserBrief? user;

  /// Mic / camera turned off by the host or a room admin.
  final bool muted;
  final bool videoMuted;
  final bool locked;

  /// The seated person's diamond balance, kept current by `balances` seat events.
  final int diamonds;

  /// When the occupant sat down. The video stage keeps guests in this order, so a late
  /// joiner lands last. Null on an empty seat and from older servers.
  final DateTime? seatedAt;

  factory Seat.fromJson(Json j) {
    final u = j.objOrNull('user');
    return Seat(
      index: j.integer('index'),
      user: u == null ? null : UserBrief.fromJson(u),
      muted: j.flag('muted'),
      videoMuted: j.flag('videoMuted'),
      locked: j.flag('locked'),
      diamonds: j.integer('diamonds'),
      seatedAt: u == null ? null : j.date('seatedAt'),
    );
  }

  /// The same seat with nobody on it (a guest who left LiveKit but is still on the seat
  /// list until the server frees it).
  Seat get vacant => Seat(index: index, muted: false, locked: locked);

  Seat copyWith({UserBrief? user, int? diamonds}) => Seat(
    index: index,
    user: user ?? this.user,
    muted: muted,
    videoMuted: videoMuted,
    locked: locked,
    diamonds: diamonds ?? this.diamonds,
    seatedAt: seatedAt,
  );
}

/// Live room reactions, in tray order. The names are the wire values: `LIVE_REACTIONS` in
/// packages/shared is the list the server accepts, and test/live_reactions_contract_test.dart
/// keeps the two in step. Append only (older apps skip names they don't know).
enum LiveReaction {
  like('👍', 'Like'),
  love('❤️', 'Love'),
  care('🥰', 'Care'),
  haha('😆', 'Haha'),
  wow('😮', 'Wow'),
  sad('😢', 'Sad'),
  angry('😡', 'Angry'),
  lol('😂', 'LOL'),
  cry('😭', 'Cry'),
  kiss('😘', 'Kiss'),
  cool('😎', 'Cool'),
  fire('🔥', 'Fire'),
  clap('👏', 'Clap'),
  party('🎉', 'Party'),
  hundred('💯', '100'),
  pray('🙏', 'Pray');

  const LiveReaction(this.emoji, this.label);
  final String emoji;
  final String label;

  /// Null for unknown names, so a newer server's reactions are skipped instead of crashing.
  static LiveReaction? fromName(Object? name) =>
      values.where((r) => r.name == name).firstOrNull;
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
    this.youtube,
    this.swappedUid,
  });
  final LiveRoom room;
  final String livekitRoom;

  /// A seated guest shown in the host's (largest) stage spot, the host taking theirs; set by
  /// the host, a room admin or staff. Null = normal layout.
  final String? swappedUid;

  /// Room admins appointed by the host.
  final List<String> moderatorIds;
  final List<UserBrief> moderators;
  final List<Seat> seats;
  final String? backgroundUrl;

  /// Server − device clock, so the elapsed time is right on a phone whose clock is off.
  final Duration clockOffset;

  /// YouTube music as the room was read; the controller keeps the newest by `rev`.
  final YouTubeState? youtube;

  RoomDetail copyWith({
    LiveRoom? room,
    List<String>? moderatorIds,
    List<UserBrief>? moderators,
    List<Seat>? seats,
    String? Function()? backgroundUrl,
    String? Function()? swappedUid,
  }) => RoomDetail(
    room: room ?? this.room,
    livekitRoom: livekitRoom,
    moderatorIds: moderatorIds ?? this.moderatorIds,
    moderators: moderators ?? this.moderators,
    seats: seats ?? this.seats,
    backgroundUrl: backgroundUrl == null ? this.backgroundUrl : backgroundUrl(),
    clockOffset: clockOffset,
    youtube: youtube,
    swappedUid: swappedUid == null ? this.swappedUid : swappedUid(),
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
      youtube: YouTubeState.tryParse(j['youtube']),
      swappedUid: j.strOrNull('swappedUid'),
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
  const LiveSession({
    required this.detail,
    required this.credentials,
    this.entry,
    this.stealth = false,
  });
  final RoomDetail detail;
  final LiveCredentials credentials;

  /// The joiner's own entrance (`bb.entry` payload): the room's copy goes out before they
  /// connect, so they play this one. Null without a tier or an entrance effect, on a
  /// reconnect, and for a hidden platform moderator.
  final Json? entry;

  /// A platform moderator connected hidden: nobody sees them, their join or their entrance.
  final bool stealth;

  factory LiveSession.fromJson(Json j) => LiveSession(
    detail: RoomDetail.fromJson(j.obj('room')),
    credentials: LiveCredentials.fromJson(j.obj('credentials')),
    entry: j.objOrNull('entry'),
    stealth: j.flag('stealth'),
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
    this.failed = false,
  });
  final String id;
  final String conversationId;
  final String senderId;
  final String type;
  final String? text;
  final String? mediaUrl;
  final DateTime? createdAt;

  /// Optimistic copy, not yet confirmed by the server.
  final bool pending;

  /// Optimistic copy whose send failed; tapping it retries with the same client id.
  final bool failed;

  ChatMessage asFailed({required bool failed}) => ChatMessage(
    id: id,
    conversationId: conversationId,
    senderId: senderId,
    type: type,
    text: text,
    mediaUrl: mediaUrl,
    createdAt: createdAt,
    pending: true,
    failed: failed,
  );

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

/// A tier package: badge artwork that puts its wearer in [tier] while it lasts.
class TierPackage {
  const TierPackage({
    required this.id,
    required this.tier,
    required this.name,
    required this.priceDiamonds,
    required this.durationDays,
    this.badge,
  });
  final String id;

  /// 1 VIP, 2 VVIP, 3 Crown, 4 King.
  final int tier;
  final String name;
  final int priceDiamonds;
  final int durationDays;
  final TierBadge? badge;

  factory TierPackage.fromJson(Json j) => TierPackage(
    id: j.str('id'),
    tier: j.integer('tier'),
    name: j.str('name'),
    priceDiamonds: j.integer('priceDiamonds'),
    durationDays: j.integer('durationDays'),
    badge: TierBadge.fromJsonOrNull(j.objOrNull('badge')),
  );
}

/// A tier package in the user's inventory.
class OwnedTierPackage {
  const OwnedTierPackage({
    required this.package,
    this.expiresAt,
    this.expired = false,
    this.worn = false,
  });
  final TierPackage package;
  final DateTime? expiresAt;
  final bool expired;

  /// The one being worn now (at most one).
  final bool worn;

  factory OwnedTierPackage.fromJson(Json j) => OwnedTierPackage(
    package: TierPackage.fromJson(j.obj('package')),
    expiresAt: j.date('expiresAt'),
    expired: j.flag('expired'),
    worn: j.flag('worn'),
  );

  OwnedTierPackage copyWith({bool? worn}) => OwnedTierPackage(
    package: package,
    expiresAt: expiresAt,
    expired: expired,
    worn: worn ?? this.worn,
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
    this.vipIncluded = false,
    this.animationFormat = 'none',
    this.owned = false,
    this.ownedUntil,
    this.equipped = false,
  });
  final String id;
  final String type;
  final String name;
  final String assetUrl;
  final String? previewUrl;
  final int priceDiamonds;
  final int durationDays;
  final int vipTierRequired;

  /// Holders of [vipTierRequired] or higher wear it free; it can't be bought.
  final bool vipIncluded;
  final String animationFormat;

  /// The caller holds it now (bought or granted). Only the store listing says; elsewhere false.
  final bool owned;
  final DateTime? ownedUntil;

  /// The caller is wearing it (store listing only).
  final bool equipped;

  /// Can be worn (has a slot): frames, entrance effects and room backgrounds.
  bool get wearable => wearableTypes.contains(type);

  /// Mirrors `EQUIPPABLE_COSMETIC_TYPES` in `packages/shared`.
  static const wearableTypes = {'frame', 'entry_animation', 'room_background'};

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
    vipIncluded: j.flag('vipIncluded'),
    owned: j.flag('owned'),
    ownedUntil: j.date('ownedUntil'),
    equipped: j.flag('equipped'),
  );
}

/// Why a game can't be opened: `disabled`, `level` (with [minLevel]), `blocked` or
/// `live_off`. Null on [GameInfo.lock] when it can.
class GameLock {
  const GameLock({required this.reason, this.minLevel});
  final String reason;
  final int? minLevel;

  factory GameLock.fromJson(Json j) => GameLock(
    reason: j.str('reason', 'disabled'),
    minLevel: j['minLevel'] == null ? null : j.integer('minLevel'),
  );

  /// What the player is told.
  String get message => switch (reason) {
    'level' => 'Reach level ${minLevel ?? 0} to play this game',
    'blocked' => 'Games are not available for your account',
    'live_off' => "This game isn't available in live rooms",
    _ => 'This game is not available right now',
  };
}

/// An AsadSoft game as the app lists it (`GET /games`).
class GameInfo {
  const GameInfo({
    required this.gameId,
    required this.name,
    required this.category,
    this.iconUrl,
    this.lock,
  });
  final String gameId;
  final String name;
  final String category;
  final String? iconUrl;
  final GameLock? lock;

  factory GameInfo.fromJson(Json j) => GameInfo(
    gameId: j.str('gameId'),
    name: j.str('name'),
    category: j.str('category', 'casual'),
    iconUrl: j.strOrNull('iconUrl'),
    lock: switch (j.objOrNull('lock')) {
      final Json l => GameLock.fromJson(l),
      null => null,
    },
  );
}

/// A launched provider session: the URL to open, carrying a session token.
class GameLaunch {
  const GameLaunch({required this.gameUrl, required this.sessionId});
  final String gameUrl;
  final String sessionId;

  factory GameLaunch.fromJson(Json j) =>
      GameLaunch(gameUrl: j.str('gameUrl'), sessionId: j.str('sessionId'));
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
    this.badge,
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
  final TierBadge? badge;
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
    badge: badge,
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
    badge: TierBadge.fromJsonOrNull(j.objOrNull('badge')),
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
    this.diamondsPerStar = defaultDiamondsPerStar,
  });

  /// One lakh diamonds make a star unless the admin sets another rate.
  static const defaultDiamondsPerStar = 100000;

  final bool maintenance;
  final String maintenanceMessage;
  final int minBuildAndroid;
  final int minBuildIos;
  final Map<String, bool> features;
  final List<int> pkDurations;
  final String termsUrl;
  final String privacyUrl;
  final String supportEmail;

  /// A wallet shows one star per this many diamonds (`app.diamondsPerStar`).
  final int diamondsPerStar;

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
      diamondsPerStar: switch (app.integer('diamondsPerStar')) {
        final n when n > 0 => n,
        _ => defaultDiamondsPerStar,
      },
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
    required this.periodDiamonds,
  });
  final AgencySummary agency;
  final int rank;
  final int periodDiamonds;
  factory TopAgency.fromJson(Json j) => TopAgency(
    agency: AgencySummary.fromJson(j),
    rank: j.integer('rank'),
    periodDiamonds: j.integer('periodDiamonds'),
  );
}

class AgencyMember {
  const AgencyMember({
    this.user,
    this.role = 'host',
    this.locked = false,
    this.dailyTargetMinutes,
    this.joinedAt,
    this.periodDiamonds = 0,
    this.periodLiveSeconds = 0,
    this.lifetimeDiamonds = 0,
    this.lifetimeLiveSeconds = 0,
    this.todayDiamonds = 0,
    this.todayLiveSeconds = 0,
    this.isLive = false,
  });
  final UserBrief? user;

  /// `host` or `admin` (agency admin).
  final String role;
  final bool locked;
  final int? dailyTargetMinutes;
  final DateTime? joinedAt;
  final int periodDiamonds;
  final int periodLiveSeconds;
  final int lifetimeDiamonds;
  final int lifetimeLiveSeconds;
  final int todayDiamonds;
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
    periodDiamonds: j.integer('periodDiamonds'),
    periodLiveSeconds: j.integer('periodLiveSeconds'),
    lifetimeDiamonds: j.integer('lifetimeDiamonds'),
    lifetimeLiveSeconds: j.integer('lifetimeLiveSeconds'),
    todayDiamonds: j.integer('todayDiamonds'),
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
    this.diamonds = 0,
    this.gifts = 0,
    this.commission = 0,
    this.liveSeconds = 0,
    this.activeHosts,
  });
  final String dayKey;
  final int diamonds;
  final int gifts;
  final int commission;
  final int liveSeconds;
  final int? activeHosts;
  factory AgencyDay.fromJson(Json j) => AgencyDay(
    dayKey: j.str('dayKey'),
    diamonds: j.integer('diamonds'),
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
    required this.diamonds,
    this.createdAt,
  });
  final String id;
  final UserBrief? sender;
  final String giftName;
  final int quantity;
  final int cost;
  final int diamonds;
  final DateTime? createdAt;
  factory AgencyGiftRow.fromJson(Json j) => AgencyGiftRow(
    id: j.str('id'),
    sender: _briefOrNull(j, 'sender'),
    giftName: j.str('giftName'),
    quantity: j.integer('quantity', 1),
    cost: j.integer('cost'),
    diamonds: j.integer('diamonds'),
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
    required this.giftDiamonds,
    required this.peakViewers,
  });
  final String id;
  final String type;
  final String title;
  final DateTime? startedAt;
  final DateTime? endedAt;
  final int durationSec;
  final int giftDiamonds;
  final int peakViewers;
  factory AgencySessionRow.fromJson(Json j) => AgencySessionRow(
    id: j.str('id'),
    type: j.str('type', 'video'),
    title: j.str('title'),
    startedAt: j.date('startedAt'),
    endedAt: j.date('endedAt'),
    durationSec: j.integer('durationSec'),
    giftDiamonds: j.integer('giftDiamonds'),
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
  final List<({int rank, UserBrief? user, int diamonds, int liveSeconds})>
  items;
  factory AgencyLeaderboard.fromJson(Json j) => AgencyLeaderboard(
    periodKey: j.str('periodKey'),
    periods: j.strings('periods'),
    items: j.list(
      'items',
      (r) => (
        rank: r.integer('rank'),
        user: _briefOrNull(r, 'user'),
        diamonds: r.integer('diamonds'),
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

// ── Live history & post-live summary ─────────────────────────────────────────────

/// One ended live in the host's broadcasting history.
class LiveHistoryItem {
  const LiveHistoryItem({
    required this.id,
    required this.isAudio,
    required this.title,
    required this.startedAt,
    this.endedAt,
    required this.durationSec,
    required this.peakViewers,
    required this.diamonds,
    this.endReason,
  });
  final String id;
  final bool isAudio;
  final String title;
  final DateTime startedAt;
  final DateTime? endedAt;
  final int durationSec;
  final int peakViewers;

  /// Diamonds the host earned (after fees).
  final int diamonds;
  final String? endReason;

  /// The title, or "Video live" / "Audio live" when it has none.
  String get label => title.isNotEmpty
      ? title
      : isAudio
      ? 'Audio live'
      : 'Video live';

  factory LiveHistoryItem.fromJson(Json j) => LiveHistoryItem(
    id: j.str('id'),
    isAudio: j.str('type') == 'audio',
    title: j.str('title'),
    startedAt: j.date('startedAt') ?? DateTime.now(),
    endedAt: j.date('endedAt'),
    durationSec: j.integer('durationSec'),
    peakViewers: j.integer('peakViewers'),
    diamonds: j.integer('giftDiamonds'),
    endReason: j.strOrNull('endReason'),
  );
}

/// The lives that started on one local day.
class LiveHistoryDay {
  const LiveHistoryDay({
    required this.date,
    required this.totalSeconds,
    required this.sessionCount,
    required this.peakViewers,
    required this.diamonds,
    required this.sessions,
  });

  /// Local midnight of the day.
  final DateTime date;
  final int totalSeconds;
  final int sessionCount;
  final int peakViewers;
  final int diamonds;
  final List<LiveHistoryItem> sessions;

  factory LiveHistoryDay.fromJson(Json j) => LiveHistoryDay(
    date: DateTime.tryParse(j.str('date')) ?? DateTime(1970),
    totalSeconds: j.integer('totalSeconds'),
    sessionCount: j.integer('sessionCount'),
    peakViewers: j.integer('peakViewers'),
    diamonds: j.integer('diamonds'),
    sessions: j.list('sessions', LiveHistoryItem.fromJson),
  );
}

/// One month of history, grouped by the day each live started (`GET
/// /users/:uid/live-history/monthly`).
class LiveHistoryMonth {
  const LiveHistoryMonth({
    required this.month,
    required this.totalSeconds,
    required this.sessionCount,
    required this.liveDays,
    required this.diamonds,
    this.earliestMonth,
    required this.days,
  });

  /// The first of the month (local).
  final DateTime month;
  final int totalSeconds;
  final int sessionCount;
  final int liveDays;
  final int diamonds;

  /// The month of the host's first live; null when they never went live.
  final DateTime? earliestMonth;

  /// Newest first.
  final List<LiveHistoryDay> days;

  static DateTime? _month(String? key) =>
      key == null ? null : DateTime.tryParse('$key-01');

  factory LiveHistoryMonth.fromJson(Json j) => LiveHistoryMonth(
    month: _month(j.strOrNull('month')) ?? DateTime(1970),
    totalSeconds: j.integer('totalSeconds'),
    sessionCount: j.integer('sessionCount'),
    liveDays: j.integer('liveDays'),
    diamonds: j.integer('diamonds'),
    earliestMonth: _month(j.strOrNull('earliestMonth')),
    days: j.list('days', LiveHistoryDay.fromJson),
  );
}

class LiveSummaryGifter {
  const LiveSummaryGifter({
    required this.rank,
    this.user,
    required this.diamonds,
    required this.gifts,
  });
  final int rank;

  /// Null when the account is gone.
  final UserBrief? user;
  final int diamonds;
  final int gifts;

  factory LiveSummaryGifter.fromJson(Json j) => LiveSummaryGifter(
    rank: j.integer('rank'),
    user: j.objOrNull('user') == null
        ? null
        : UserBrief.fromJson(j.obj('user')),
    diamonds: j.integer('diamonds'),
    gifts: j.integer('gifts'),
  );
}

class LiveSummaryGift {
  const LiveSummaryGift({
    required this.name,
    this.iconUrl,
    required this.count,
    required this.diamonds,
  });
  final String name;
  final String? iconUrl;
  final int count;
  final int diamonds;

  factory LiveSummaryGift.fromJson(Json j) => LiveSummaryGift(
    name: j.obj('gift').str('name'),
    iconUrl: j.obj('gift').strOrNull('iconUrl'),
    count: j.integer('count'),
    diamonds: j.integer('diamonds'),
  );
}

/// How one ended live went (`GET /live/:id/summary`).
class LiveSummary {
  const LiveSummary({
    required this.roomId,
    required this.isAudio,
    required this.title,
    required this.startedAt,
    required this.endedAt,
    this.endReason,
    required this.durationSec,
    required this.isFinal,
    required this.peakViewers,
    this.totalJoins,
    this.uniqueViewers,
    required this.newFollowers,
    this.chatMessages,
    this.reactions,
    required this.hostDiamonds,
    required this.hostEarnings,
    required this.roomDiamonds,
    required this.giftCount,
    required this.gifters,
    required this.topGifters,
    required this.topGifts,
  });
  final String roomId;
  final bool isAudio;
  final String title;
  final DateTime startedAt;
  final DateTime endedAt;
  final String? endReason;
  final int durationSec;

  /// False for about a minute after the end, while late gifts may still count.
  final bool isFinal;
  final int peakViewers;

  /// Null for lives that ended before the counter existed.
  final int? totalJoins;
  final int? uniqueViewers;
  final int newFollowers;
  final int? chatMessages;
  final int? reactions;

  /// Cost of the gifts the host received, and what they were credited after fees.
  final int hostDiamonds;
  final int hostEarnings;

  /// Every gift in the room (host and guests), at cost.
  final int roomDiamonds;
  final int giftCount;
  final int gifters;
  final List<LiveSummaryGifter> topGifters;
  final List<LiveSummaryGift> topGifts;

  String get label => title.isNotEmpty
      ? title
      : isAudio
      ? 'Audio live'
      : 'Video live';

  static int? _maybe(Json j, String k) => j[k] is num ? j.integer(k) : null;

  factory LiveSummary.fromJson(Json j) {
    final audience = j.obj('audience');
    final engagement = j.obj('engagement');
    final gifts = j.obj('gifts');
    final started = j.date('startedAt') ?? DateTime.now();
    return LiveSummary(
      roomId: j.str('roomId'),
      isAudio: j.str('type') == 'audio',
      title: j.str('title'),
      startedAt: started,
      endedAt: j.date('endedAt') ?? started,
      endReason: j.strOrNull('endReason'),
      durationSec: j.integer('durationSec'),
      isFinal: j.flag('final', true),
      peakViewers: audience.integer('peakViewers'),
      totalJoins: _maybe(audience, 'totalJoins'),
      uniqueViewers: _maybe(audience, 'uniqueViewers'),
      newFollowers: audience.integer('newFollowers'),
      chatMessages: _maybe(engagement, 'chatMessages'),
      reactions: _maybe(engagement, 'reactions'),
      hostDiamonds: gifts.integer('hostDiamonds'),
      hostEarnings: gifts.integer('hostEarnings'),
      roomDiamonds: gifts.integer('roomDiamonds'),
      giftCount: gifts.integer('giftCount'),
      gifters: gifts.integer('gifters'),
      topGifters: gifts.list('topGifters', LiveSummaryGifter.fromJson),
      topGifts: gifts.list('topGifts', LiveSummaryGift.fromJson),
    );
  }
}
