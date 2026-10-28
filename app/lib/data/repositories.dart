import 'dart:io';

import '../core/network/api_client.dart';
import '../core/utils/json.dart';
import '../models/models.dart';

/// Typed wrappers over the REST API, one per domain. Screens never touch [ApiClient] directly.
class AccountRepository {
  AccountRepository(this._api);
  final ApiClient _api;

  Future<MeUser> session({String? displayName}) async {
    final j = await _api.post(
      '/auth/session',
      body: {'displayName': ?displayName},
    );
    return MeUser.fromJson(j.obj('user'));
  }

  Future<MeUser> me() async =>
      MeUser.fromJson((await _api.get('/me')).obj('user'));

  Future<MeUser> updateProfile(Map<String, Object?> patch) async =>
      MeUser.fromJson((await _api.patch('/me', body: patch)).obj('user'));

  Future<String> uploadAvatar(File file) =>
      _api.upload(kind: 'avatar', file: file, contentType: _mime(file.path));

  Future<void> deleteAccount() => _api.delete('/me');

  Future<void> registerPushToken(String token, String platform) => _api.post(
    '/me/push-tokens',
    body: {'token': token, 'platform': platform},
  );

  Future<void> removePushToken(String token) =>
      _api.delete('/me/push-tokens', body: {'token': token});

  Future<PublicUser> user(String uid) async =>
      PublicUser.fromJson((await _api.get('/users/$uid')).obj('user'));

  Future<List<UserBrief>> search(String q) async => (await _api.get(
    '/users/search',
    query: {'q': q},
  )).list('items', UserBrief.fromJson);

  Future<void> follow(String uid, bool follow) => follow
      ? _api.post('/users/$uid/follow')
      : _api.delete('/users/$uid/follow');

  Future<Paged<UserBrief>> follows(
    String uid,
    String direction, {
    String? cursor,
  }) async => Paged.fromJson(
    await _api.get('/users/$uid/$direction', query: {'cursor': cursor}),
    UserBrief.fromJson,
  );

  Future<void> block(String uid, bool block) =>
      block ? _api.post('/users/$uid/block') : _api.delete('/users/$uid/block');

  Future<List<UserBrief>> blocked() async =>
      (await _api.get('/me/blocked')).list('items', UserBrief.fromJson);

  Future<void> report({
    required String targetType,
    required String targetId,
    required String reason,
    String details = '',
  }) => _api.post(
    '/reports',
    body: {
      'targetType': targetType,
      'targetId': targetId,
      'reason': reason,
      'details': details,
    },
  );

  Future<List<({UserBrief? user, int diamonds})>> contributors(
    String uid,
  ) async => (await _api.get('/users/$uid/contributors')).list(
    'items',
    (j) => (
      user: j.objOrNull('user') == null
          ? null
          : UserBrief.fromJson(j.obj('user')),
      diamonds: j.integer('diamonds'),
    ),
  );
}

String _mime(String path) {
  final p = path.toLowerCase();
  if (p.endsWith('.png')) return 'image/png';
  if (p.endsWith('.webp')) return 'image/webp';
  if (p.endsWith('.mp4')) return 'video/mp4';
  if (p.endsWith('.m4a')) return 'audio/mp4';
  if (p.endsWith('.aac')) return 'audio/aac';
  return 'image/jpeg';
}

class ContentRepository {
  ContentRepository(this._api);
  final ApiClient _api;

  Future<AppConfig> appConfig() async =>
      AppConfig.fromJson(await _api.get('/config/app'));
  Future<List<BannerItem>> banners(String placement) async => (await _api.get(
    '/banners',
    query: {'placement': placement},
  )).list('items', BannerItem.fromJson);
  Future<List<LeaderboardEntry>> leaderboard(
    String kind,
    String period,
  ) async => (await _api.get(
    '/leaderboards/$kind',
    query: {'period': period},
  )).list('items', LeaderboardEntry.fromJson);
  Future<String> upload(String kind, File file) =>
      _api.upload(kind: kind, file: file, contentType: _mime(file.path));
}

class LiveRepository {
  LiveRepository(this._api);
  final ApiClient _api;

  Future<Paged<LiveRoom>> list({
    required String tab,
    String? type,
    int page = 1,
  }) async => Paged.fromJson(
    await _api.get(
      '/live',
      query: {'tab': tab, 'type': type, 'page': page, 'pageSize': 30},
    ),
    LiveRoom.fromJson,
  );

  /// A null [title] or [coverUrl] lets the server default them to the host's
  /// display name and avatar.
  Future<LiveSession> start({
    String? title,
    required String type,
    String? coverUrl,
  }) async => LiveSession.fromJson(
    await _api.post(
      '/live',
      body: {'title': ?title, 'type': type, 'coverUrl': coverUrl},
    ),
  );

  /// [password] unlocks a locked room that has one.
  Future<LiveSession> join(String roomId, {String? password}) async =>
      LiveSession.fromJson(
        await _api.post(
          '/live/$roomId/join',
          body: password == null ? null : {'password': password},
        ),
      );
  Future<RoomDetail> detail(String roomId) async =>
      RoomDetail.fromJson((await _api.get('/live/$roomId')).obj('room'));
  Future<void> heartbeat(String roomId) => _api.post('/live/$roomId/heartbeat');
  Future<void> chat(String roomId, String text, {String? replyToId}) =>
      _api.post(
        '/live/$roomId/chat',
        body: {'type': 'text', 'text': text, 'replyToId': ?replyToId},
      );
  Future<void> voiceChat(
    String roomId,
    File file,
    int durationSec, {
    String? replyToId,
  }) async {
    final url = await _api.upload(
      kind: 'voice',
      file: file,
      contentType: _mime(file.path),
    );
    await _api.post(
      '/live/$roomId/chat',
      body: {
        'type': 'voice',
        'voiceUrl': url,
        'durationSec': durationSec,
        'replyToId': ?replyToId,
      },
    );
  }

  Future<void> deleteChat(String roomId, String messageId) =>
      _api.delete('/live/$roomId/chat/$messageId');
  Future<void> react(String roomId, int count) =>
      _api.post('/live/$roomId/reactions', body: {'count': count});

  /// Host only. Locking without a [password] admits nobody new.
  Future<RoomDetail> setLock(
    String roomId, {
    required bool locked,
    String? password,
  }) async => RoomDetail.fromJson(
    (await _api.post(
      '/live/$roomId/lock',
      body: {'locked': locked, 'password': password},
    )).obj('room'),
  );
  Future<Json> end(String roomId) async =>
      (await _api.post('/live/$roomId/end')).obj('summary');
  Future<List<UserBrief>> viewers(String roomId) async =>
      (await _api.get('/live/$roomId/viewers'))
          .list('items', UserBrief.fromJson);
  Future<void> kick(String roomId, String uid, {int? banMinutes = 60}) =>
      _api.post(
        '/live/$roomId/kick',
        body: {'userId': uid, 'banMinutes': banMinutes},
      );
  Future<void> setModerator(String roomId, String uid, bool enabled) =>
      _api.post(
        '/live/$roomId/moderators',
        body: {'userId': uid, 'enabled': enabled},
      );
  Future<void> requestSeat(String roomId) =>
      _api.post('/live/$roomId/seats/request');
  Future<void> cancelSeatRequest(String roomId) =>
      _api.delete('/live/$roomId/seats/request');
  Future<List<SeatRequest>> seatRequests(String roomId) async =>
      (await _api.get('/live/$roomId/seats/requests'))
          .list('items', SeatRequest.fromJson);
  Future<void> decideSeat(String roomId, String uid, bool accept) =>
      _api.post('/live/$roomId/seats/requests/$uid', body: {'accept': accept});
  Future<void> inviteToSeat(String roomId, String uid) =>
      _api.post('/live/$roomId/seats/invite', body: {'userId': uid});
  Future<void> respondToSeatInvite(String roomId, bool accept) =>
      _api.post('/live/$roomId/seats/invite/respond', body: {'accept': accept});
  Future<void> leaveSeat(String roomId) =>
      _api.post('/live/$roomId/seats/leave');
  Future<void> manageSeat(String roomId, int index, String action) =>
      _api.post('/live/$roomId/seats/$index', body: {'action': action});

  Future<Json?> pkForRoom(String roomId) async {
    final j = await _api.get('/live/$roomId/pk');
    return j.isEmpty ? null : j;
  }

  Future<PkBattle> pkInvite(String opponentId, int durationSec) async =>
      PkBattle.fromJson(
        (await _api.post(
          '/pk/invite',
          body: {'opponentId': opponentId, 'durationSec': durationSec},
        )).obj('battle'),
      );
  Future<PkBattle> pkRandom(int durationSec) async => PkBattle.fromJson(
    (await _api.post(
      '/pk/random',
      body: {'durationSec': durationSec},
    )).obj('battle'),
  );
  Future<void> pkRespond(String battleId, bool accept) =>
      _api.post('/pk/$battleId/respond', body: {'accept': accept});
  Future<void> pkCancel(String battleId) => _api.post('/pk/$battleId/cancel');
  Future<void> pkEnd(String battleId) => _api.post('/pk/$battleId/end');
  Future<void> pkNextRound(String battleId) =>
      _api.post('/pk/$battleId/next-round');
  Future<List<PkCandidate>> pkHosts({String tab = 'all'}) async =>
      (await _api.get(
        '/pk/hosts',
        query: {'tab': tab},
      )).list('items', PkCandidate.fromJson);

  Future<Json> history(String uid, {int page = 1}) =>
      _api.get('/users/$uid/live-history', query: {'page': page});
}

class EconomyRepository {
  EconomyRepository(this._api);
  final ApiClient _api;

  Future<List<Gift>> gifts() async =>
      (await _api.get('/gifts')).list('items', Gift.fromJson);

  // Money-moving calls take the caller's [idempotencyKey] (one per user intent, reused on a
  // manual retry). Without one, a key is minted per call, which only covers network retries.

  Future<int> sendGift({
    required String giftId,
    required int quantity,
    required List<String> receiverIds,
    String? roomId,
    String? idempotencyKey,
  }) async {
    final j = await _api.post(
      '/gifts/send',
      idempotent: true,
      idempotencyKey: idempotencyKey,
      body: {
        'giftId': giftId,
        'quantity': quantity,
        'receiverIds': receiverIds,
        'roomId': roomId,
      },
    );
    return j.integer('diamonds');
  }

  Future<Wallet> wallet() async => Wallet.fromJson(await _api.get('/wallet'));
  Future<Paged<LedgerEntry>> ledger({String? currency, String? cursor}) async =>
      Paged.fromJson(
        await _api.get(
          '/wallet/ledger',
          query: {'currency': currency, 'cursor': cursor},
        ),
        LedgerEntry.fromJson,
      );
  Future<List<RechargePackage>> packages() async =>
      (await _api.get('/wallet/packages'))
          .list('items', RechargePackage.fromJson);

  /// Store receipts are verified with a key derived from the purchase itself, so every
  /// redelivery of the same purchase is the same request to the server.
  Future<Json> verifyGoogle(
    String productId,
    String token, {
    required String idempotencyKey,
  }) => _api.post(
    '/wallet/iap/verify',
    idempotencyKey: idempotencyKey,
    body: {'store': 'google', 'productId': productId, 'purchaseToken': token},
  );
  Future<Json> verifyApple(
    String transactionId, {
    required String idempotencyKey,
  }) => _api.post(
    '/wallet/iap/verify',
    idempotencyKey: idempotencyKey,
    body: {'store': 'apple', 'transactionId': transactionId},
  );

  Future<UserBrief> agentLookup(String shortId) async => UserBrief.fromJson(
    (await _api.get('/agent/lookup/${Uri.encodeComponent(shortId)}'))
        .obj('user'),
  );
  Future<int> agentRecharge(
    String target,
    int diamonds, {
    String? idempotencyKey,
  }) async => (await _api.post(
    '/agent/recharge',
    idempotent: true,
    idempotencyKey: idempotencyKey,
    body: {'target': target, 'diamonds': diamonds},
  )).integer('agentStock');
  Future<Paged<AgentRecharge>> agentHistory({
    String? cursor,
    String? shortId,
  }) async => Paged.fromJson(
    await _api.get('/agent/history', query: {'cursor': cursor, 'q': shortId}),
    AgentRecharge.fromJson,
  );
  Future<AgentSummary> agentSummary() async =>
      AgentSummary.fromJson(await _api.get('/agent/summary'));

  Future<List<VipPackage>> vipPackages() async =>
      (await _api.get('/store/vip')).list('items', VipPackage.fromJson);
  Future<Json> buyVip(String id, {String? idempotencyKey}) => _api.post(
    '/store/vip/$id/purchase',
    idempotent: true,
    idempotencyKey: idempotencyKey,
  );
  Future<List<StoreItem>> storeItems({String? type}) async => (await _api.get(
    '/store/items',
    query: {'type': type},
  )).list('items', StoreItem.fromJson);
  Future<Json> buyItem(String id, {String? idempotencyKey}) => _api.post(
    '/store/items/$id/purchase',
    idempotent: true,
    idempotencyKey: idempotencyKey,
  );
  Future<List<({StoreItem item, DateTime? expiresAt, bool equipped})>>
  owned() async => (await _api.get('/store/mine')).list(
    'items',
    (j) => (
      item: StoreItem.fromJson(j.obj('item')),
      expiresAt: j.date('expiresAt'),
      equipped: j.flag('equipped'),
    ),
  );
  Future<void> equip(String? itemId, String type) =>
      _api.post('/store/equip', body: {'itemId': itemId, 'type': type});

  Future<Json> requestWithdrawal({
    required int beans,
    required String method,
    required Map<String, String> account,
    String? idempotencyKey,
  }) => _api.post(
    '/withdrawals',
    idempotent: true,
    idempotencyKey: idempotencyKey,
    body: {'beans': beans, 'method': method, 'account': account},
  );
  Future<List<Json>> withdrawals() async =>
      (await _api.get('/withdrawals')).list('items', (j) => j);

  Future<List<GameInfo>> games() async =>
      (await _api.get('/games')).list('items', GameInfo.fromJson);
}

/// Host agencies: browsing and joining as a host, and running one as its owner or admin.
class AgencyRepository {
  AgencyRepository(this._api);
  final ApiClient _api;

  // Everyone
  Future<List<TopAgency>> top({int limit = 20}) async => (await _api.get(
    '/agencies/top',
    query: {'limit': limit},
  )).list('items', TopAgency.fromJson);
  Future<List<AgencySummary>> search(String q) async => (await _api.get(
    '/agencies',
    query: {'q': q},
  )).list('items', AgencySummary.fromJson);
  Future<AgencyMembership?> membership() async {
    final m = (await _api.get('/agencies/membership')).objOrNull('membership');
    return m == null ? null : AgencyMembership.fromJson(m);
  }

  Future<void> apply(String agencyId) => _api.post('/agencies/$agencyId/join');
  Future<void> leave() => _api.post('/agencies/leave');
  Future<List<AgencyInvitation>> myInvitations() async =>
      (await _api.get('/agencies/invitations'))
          .list('items', AgencyInvitation.fromJson);
  Future<void> respondInvitation(String id, {required bool accept}) =>
      _api.post('/agencies/invitations/$id', body: {'accept': accept});

  // Owner and agency admins
  Future<AgencyDashboard> dashboard() async =>
      AgencyDashboard.fromJson(await _api.get('/agencies/mine'));
  Future<AgencySummary> updateProfile({String? name, String? logoUrl}) async =>
      AgencySummary.fromJson(
        (await _api.patch(
          '/agencies/mine',
          body: {'name': ?name, 'logoUrl': ?logoUrl},
        )).obj('agency'),
      );
  Future<String> uploadLogo(File file) => _api.upload(
    kind: 'agency-logo',
    file: file,
    contentType: _mime(file.path),
  );
  Future<List<AgencyMember>> members() async =>
      (await _api.get('/agencies/mine/members'))
          .list('items', AgencyMember.fromJson);
  Future<void> removeMember(String uid) =>
      _api.delete('/agencies/mine/members/$uid');
  Future<void> setRole(String uid, String role) =>
      _api.post('/agencies/mine/members/$uid/role', body: {'role': role});
  Future<void> lock(String uid) =>
      _api.post('/agencies/mine/members/$uid/lock');
  Future<void> setTarget(String uid, int? minutes) => _api.put(
    '/agencies/mine/members/$uid/target',
    body: {'minutes': minutes},
  );
  Future<AgencyAnalytics> hostAnalytics(String uid, {int days = 30}) async =>
      AgencyAnalytics.fromJson(
        await _api.get(
          '/agencies/mine/members/$uid/analytics',
          query: {'days': days},
        ),
      );
  Future<Paged<AgencyGiftRow>> hostGifts(String uid, {String? cursor}) async =>
      Paged.fromJson(
        await _api.get(
          '/agencies/mine/members/$uid/gifts',
          query: {'cursor': cursor},
        ),
        AgencyGiftRow.fromJson,
      );
  Future<Paged<AgencySessionRow>> hostSessions(
    String uid, {
    String? cursor,
  }) async => Paged.fromJson(
    await _api.get(
      '/agencies/mine/members/$uid/sessions',
      query: {'cursor': cursor},
    ),
    AgencySessionRow.fromJson,
  );
  Future<List<AgencyRequest>> requests() async =>
      (await _api.get('/agencies/mine/requests'))
          .list('items', AgencyRequest.fromJson);
  Future<void> decideRequest(String id, {required bool approve}) =>
      _api.post('/agencies/mine/requests/$id', body: {'approve': approve});
  Future<List<AgencyInvitation>> invitations() async =>
      (await _api.get('/agencies/mine/invitations'))
          .list('items', AgencyInvitation.fromJson);
  Future<AgencyInvitation> invite(String shortId) async =>
      AgencyInvitation.fromJson(
        (await _api.post(
          '/agencies/mine/invitations',
          body: {'target': shortId},
        )).obj('invitation'),
      );
  Future<void> cancelInvitation(String id) =>
      _api.delete('/agencies/mine/invitations/$id');
  Future<AgencyAnalytics> analytics({int days = 30}) async =>
      AgencyAnalytics.fromJson(
        await _api.get('/agencies/mine/analytics', query: {'days': days}),
      );
  Future<AgencyLeaderboard> leaderboard({String? periodKey}) async =>
      AgencyLeaderboard.fromJson(
        await _api.get(
          '/agencies/mine/leaderboard',
          query: {'periodKey': periodKey},
        ),
      );
  Future<Paged<AgencyAuditRow>> audit({String? cursor}) async => Paged.fromJson(
    await _api.get('/agencies/mine/audit', query: {'cursor': cursor}),
    AgencyAuditRow.fromJson,
  );
}

class SocialRepository {
  SocialRepository(this._api);
  final ApiClient _api;

  Future<Paged<Conversation>> conversations({String? cursor}) async =>
      Paged.fromJson(
        await _api.get('/chat/conversations', query: {'cursor': cursor}),
        Conversation.fromJson,
      );
  Future<String> conversationWith(String uid) async =>
      (await _api.post('/chat/conversations', body: {'userId': uid})).str('id');
  Future<Paged<ChatMessage>> messages(
    String conversationId, {
    String? cursor,
  }) async => Paged.fromJson(
    await _api.get(
      '/chat/conversations/$conversationId/messages',
      query: {'cursor': cursor, 'limit': 30},
    ),
    ChatMessage.fromJson,
  );
  Future<ChatMessage> send({
    required String to,
    String? text,
    String? mediaUrl,
    required String clientId,
  }) async => ChatMessage.fromJson(
    (await _api.post(
      '/chat/messages',
      body: {
        'toUserId': to,
        'type': mediaUrl != null ? 'image' : 'text',
        'text': text,
        'mediaUrl': mediaUrl,
        'clientId': clientId,
      },
    )).obj('message'),
  );
  Future<void> markRead(String conversationId) =>
      _api.post('/chat/conversations/$conversationId/read');

  Future<Paged<FeedPost>> feed(
    String tab, {
    String? cursor,
    String? authorId,
  }) async => Paged.fromJson(
    await _api.get(
      '/feed',
      query: {'tab': tab, 'cursor': cursor, 'authorId': authorId},
    ),
    FeedPost.fromJson,
  );
  Future<FeedPost> createPost(String text, List<String> imageUrls) async =>
      FeedPost.fromJson(
        (await _api.post(
          '/feed',
          body: {
            'text': text,
            'media': [
              for (final u in imageUrls) {'url': u, 'type': 'image'},
            ],
          },
        )).obj('post'),
      );
  Future<FeedPost> post(String id) async =>
      FeedPost.fromJson((await _api.get('/feed/$id')).obj('post'));
  Future<void> deletePost(String id) => _api.delete('/feed/$id');
  Future<int> like(String id, bool like) async =>
      (like
              ? await _api.post('/feed/$id/like')
              : await _api.delete('/feed/$id/like'))
          .integer('likeCount');
  Future<Paged<FeedComment>> comments(String id, {String? cursor}) async =>
      Paged.fromJson(
        await _api.get('/feed/$id/comments', query: {'cursor': cursor}),
        FeedComment.fromJson,
      );
  Future<FeedComment> comment(String id, String text) async =>
      FeedComment.fromJson(
        (await _api.post(
          '/feed/$id/comments',
          body: {'text': text},
        )).obj('comment'),
      );

  Future<Paged<AppNotification>> notifications({String? cursor}) async =>
      Paged.fromJson(
        await _api.get('/notifications', query: {'cursor': cursor}),
        AppNotification.fromJson,
      );
  Future<({int notifications, int chat})> unreadCounts() async {
    final j = await _api.get('/notifications/unread-count');
    return (notifications: j.integer('notifications'), chat: j.integer('chat'));
  }

  Future<void> markAllNotificationsRead() =>
      _api.post('/notifications/read', body: {'ids': 'all'});
}
