import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:image_picker/image_picker.dart';
import 'package:package_info_plus/package_info_plus.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../core/providers.dart';
import '../../core/theme/bb_colors.dart';
import '../../core/utils/format.dart';
import '../../core/utils/json.dart';
import '../../core/widgets/widgets.dart';
import '../../models/models.dart';

final userProvider = FutureProvider.autoDispose.family<PublicUser, String>(
  (ref, uid) => ref.watch(accountRepo).user(uid),
);
final _contributorsProvider = FutureProvider.autoDispose.family(
  (ref, String uid) => ref.watch(accountRepo).contributors(uid),
);
final _blockedProvider = FutureProvider.autoDispose(
  (ref) => ref.watch(accountRepo).blocked(),
);
final _historyProvider = FutureProvider.autoDispose.family(
  (ref, String uid) => ref.watch(liveRepo).history(uid),
);
final _versionProvider = FutureProvider((_) => PackageInfo.fromPlatform());

class MeScreen extends ConsumerWidget {
  const MeScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final me = ref.watch(meProvider);
    final unread = ref.watch(unreadProvider).value;
    final p = me.profile;
    return Scaffold(
      body: RefreshIndicator(
        onRefresh: () => ref.read(sessionProvider.notifier).refresh(),
        child: ListView(
          padding: EdgeInsets.zero,
          children: [
            Container(
              padding: EdgeInsets.fromLTRB(
                20,
                MediaQuery.paddingOf(context).top + 16,
                20,
                20,
              ),
              decoration: const BoxDecoration(
                gradient: BBColors.champagneGradient,
              ),
              child: Column(
                children: [
                  Row(
                    children: [
                      const Spacer(),
                      IconButton(
                        tooltip: 'Notifications',
                        onPressed: () => context.push('/notifications'),
                        icon: Badge(
                          isLabelVisible: (unread?.notifications ?? 0) > 0,
                          label: Text('${unread?.notifications ?? 0}'),
                          child: const Icon(Icons.notifications_none_rounded),
                        ),
                      ),
                      IconButton(
                        tooltip: 'Settings',
                        onPressed: () => context.push('/settings'),
                        icon: const Icon(Icons.settings_outlined),
                      ),
                    ],
                  ),
                  BBAvatar(
                    url: p.brief.avatarUrl,
                    name: p.brief.displayName,
                    size: 92,
                    frameUrl: p.brief.frameUrl,
                    vip: p.brief.vipTier > 0,
                  ),
                  const SizedBox(height: 12),
                  Text(
                    p.brief.displayName,
                    style: Theme.of(context).textTheme.headlineSmall,
                  ),
                  const SizedBox(height: 6),
                  Row(
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: [
                      Text(
                        'ID ${p.brief.shortId}',
                        style: const TextStyle(color: BBColors.inkMuted),
                      ),
                      const SizedBox(width: 8),
                      LevelBadge(p.brief.level),
                      const SizedBox(width: 6),
                      VipBadge(p.brief.vipTier),
                    ],
                  ),
                  const SizedBox(height: 16),
                  Row(
                    mainAxisAlignment: MainAxisAlignment.spaceEvenly,
                    children: [
                      _Stat(
                        'Followers',
                        p.followers,
                        () => context.push('/user/${p.id}/followers'),
                      ),
                      _Stat(
                        'Following',
                        p.following,
                        () => context.push('/user/${p.id}/following'),
                      ),
                    ],
                  ),
                  const SizedBox(height: 16),
                  _LevelCard(progress: me.levelProgress),
                ],
              ),
            ),
            Padding(
              padding: const EdgeInsets.all(16),
              child: Row(
                children: [
                  Expanded(
                    child: _WalletTile(
                      label: 'Diamonds',
                      child: DiamondAmount(
                        me.wallet.diamonds,
                        style: const TextStyle(fontSize: 18),
                      ),
                      onTap: () => context.push('/wallet'),
                    ),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: _WalletTile(
                      label: 'Beans',
                      child: DiamondAmount(
                        me.wallet.beans,
                        beans: true,
                        style: const TextStyle(fontSize: 18),
                      ),
                      onTap: () => context.push('/wallet'),
                    ),
                  ),
                ],
              ),
            ),
            _MenuCard(
              children: [
                _MenuItem(
                  icon: Icons.workspace_premium_outlined,
                  label: 'VIP membership',
                  onTap: () => context.push('/vip'),
                ),
                _MenuItem(
                  icon: Icons.storefront_outlined,
                  label: 'Store · frames & entries',
                  onTap: () => context.push('/store'),
                ),
                _MenuItem(
                  icon: Icons.casino_outlined,
                  label: 'Games',
                  onTap: () => context.push('/games'),
                ),
                _MenuItem(
                  icon: Icons.emoji_events_outlined,
                  label: 'Rankings',
                  onTap: () => context.push('/leaderboard'),
                ),
              ],
            ),
            const SizedBox(height: 12),
            _MenuCard(
              children: [
                _MenuItem(
                  icon: Icons.history_rounded,
                  label: 'Live history',
                  onTap: () => context.push('/history'),
                ),
                _MenuItem(
                  icon: Icons.groups_2_outlined,
                  label: 'Host agency',
                  onTap: () => context.push('/agency'),
                ),
                if (me.isAgent)
                  _MenuItem(
                    icon: Icons.storefront_rounded,
                    label:
                        'Agent recharge · ${Fmt.compact(me.wallet.agentStock)} stock',
                    onTap: () => context.push('/agent'),
                  ),
                _MenuItem(
                  icon: Icons.account_balance_outlined,
                  label: 'Withdraw beans',
                  onTap: () => context.push('/wallet/withdraw'),
                ),
              ],
            ),
            const SizedBox(height: 32),
          ],
        ),
      ),
    );
  }
}

class _LevelCard extends StatelessWidget {
  const _LevelCard({required this.progress});
  final LevelProgress progress;

  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.all(14),
    decoration: BoxDecoration(
      color: BBColors.surface,
      borderRadius: BorderRadius.circular(16),
      border: Border.all(color: BBColors.border),
    ),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            LevelBadge(progress.level),
            const Spacer(),
            Text(
              progress.isMaxLevel
                  ? 'Max level'
                  : 'Next at ${Fmt.compact(progress.nextLevelPoints ?? 0)}',
              style: const TextStyle(color: BBColors.inkMuted, fontSize: 12),
            ),
          ],
        ),
        const SizedBox(height: 10),
        ClipRRect(
          borderRadius: BorderRadius.circular(6),
          child: LinearProgressIndicator(
            value: progress.fraction,
            minHeight: 8,
            backgroundColor: BBColors.surfaceMuted,
            valueColor: const AlwaysStoppedAnimation(BBColors.gold),
          ),
        ),
        const SizedBox(height: 6),
        Text(
          '${Fmt.full(progress.points)} points · recharge and receive gifts to level up',
          style: const TextStyle(color: BBColors.inkSubtle, fontSize: 11),
        ),
      ],
    ),
  );
}

class _Stat extends StatelessWidget {
  const _Stat(this.label, this.value, this.onTap);
  final String label;
  final int value;
  final VoidCallback onTap;
  @override
  Widget build(BuildContext context) => InkWell(
    onTap: onTap,
    borderRadius: BorderRadius.circular(12),
    child: Padding(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 6),
      child: Column(
        children: [
          Text(
            Fmt.compact(value),
            style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 18),
          ),
          Text(label, style: const TextStyle(color: BBColors.inkMuted)),
        ],
      ),
    ),
  );
}

class _WalletTile extends StatelessWidget {
  const _WalletTile({
    required this.label,
    required this.child,
    required this.onTap,
  });
  final String label;
  final Widget child;
  final VoidCallback onTap;
  @override
  Widget build(BuildContext context) => Card(
    child: InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(18),
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(label, style: const TextStyle(color: BBColors.inkMuted)),
            const SizedBox(height: 6),
            child,
          ],
        ),
      ),
    ),
  );
}

class _MenuCard extends StatelessWidget {
  const _MenuCard({required this.children});
  final List<Widget> children;
  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.symmetric(horizontal: 16),
    child: Card(child: Column(children: children)),
  );
}

class _MenuItem extends StatelessWidget {
  const _MenuItem({
    required this.icon,
    required this.label,
    required this.onTap,
  });
  final IconData icon;
  final String label;
  final VoidCallback onTap;
  @override
  Widget build(BuildContext context) => ListTile(
    leading: Icon(icon),
    title: Text(label),
    trailing: const Icon(
      Icons.chevron_right_rounded,
      color: BBColors.inkSubtle,
    ),
    onTap: onTap,
  );
}

class UserProfileScreen extends ConsumerWidget {
  const UserProfileScreen({super.key, required this.uid});
  final String uid;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final user = ref.watch(userProvider(uid));
    final isMe = ref.watch(meProvider).id == uid;
    return Scaffold(
      appBar: AppBar(
        actions: [
          if (!isMe)
            PopupMenuButton<String>(
              onSelected: (v) async {
                try {
                  if (v == 'report') {
                    await ReportSheet.show(
                      context,
                      targetType: 'user',
                      targetId: uid,
                    );
                  }
                  if (v == 'block') {
                    await ref
                        .read(accountRepo)
                        .block(uid, !(user.value?.isBlocked ?? false));
                    ref.invalidate(userProvider(uid));
                  }
                } catch (e) {
                  if (context.mounted) showError(context, e);
                }
              },
              itemBuilder: (_) => [
                const PopupMenuItem(value: 'report', child: Text('Report')),
                PopupMenuItem(
                  value: 'block',
                  child: Text(
                    user.value?.isBlocked ?? false ? 'Unblock' : 'Block',
                  ),
                ),
              ],
            ),
        ],
      ),
      body: AsyncView(
        value: user,
        onRetry: () => ref.invalidate(userProvider(uid)),
        data: (u) => ListView(
          padding: const EdgeInsets.all(20),
          children: [
            Center(
              child: BBAvatar(
                url: u.brief.avatarUrl,
                name: u.brief.displayName,
                size: 100,
                frameUrl: u.brief.frameUrl,
                vip: u.brief.vipTier > 0,
                live: u.isLive,
              ),
            ),
            const SizedBox(height: 12),
            Center(
              child: Text(
                u.brief.displayName,
                style: Theme.of(context).textTheme.headlineSmall,
              ),
            ),
            const SizedBox(height: 6),
            Row(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                Text(
                  'ID ${u.brief.shortId}',
                  style: const TextStyle(color: BBColors.inkMuted),
                ),
                const SizedBox(width: 8),
                LevelBadge(u.brief.level),
                const SizedBox(width: 6),
                VipBadge(u.brief.vipTier),
              ],
            ),
            if (u.bio.isNotEmpty)
              Padding(
                padding: const EdgeInsets.only(top: 12),
                child: Text(u.bio, textAlign: TextAlign.center),
              ),
            const SizedBox(height: 16),
            Row(
              mainAxisAlignment: MainAxisAlignment.spaceEvenly,
              children: [
                _Stat(
                  'Followers',
                  u.followers,
                  () => context.push('/user/$uid/followers'),
                ),
                _Stat(
                  'Following',
                  u.following,
                  () => context.push('/user/$uid/following'),
                ),
              ],
            ),
            const SizedBox(height: 20),
            if (!isMe)
              Row(
                children: [
                  Expanded(
                    child: u.isFollowing
                        ? OutlinedButton(
                            onPressed: () => _follow(ref, false),
                            child: const Text('Following'),
                          )
                        : GoldButton(
                            label: 'Follow',
                            height: 48,
                            onPressed: () => _follow(ref, true),
                          ),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: OutlinedButton.icon(
                      icon: const Icon(Icons.chat_bubble_outline_rounded),
                      label: const Text('Message'),
                      onPressed: u.isBlocked
                          ? null
                          : () async {
                              final id = await ref
                                  .read(socialRepo)
                                  .conversationWith(uid);
                              if (context.mounted) {
                                unawaited(
                                  context.push('/chat/$id', extra: u.brief),
                                );
                              }
                            },
                    ),
                  ),
                ],
              ),
            if (u.isLive && u.liveRoomId != null) ...[
              const SizedBox(height: 12),
              FilledButton.icon(
                onPressed: () => context.push('/live/${u.liveRoomId}'),
                icon: const Icon(Icons.live_tv_rounded),
                label: const Text('Watch live now'),
              ),
            ],
            const SizedBox(height: 24),
            Text(
              'Top supporters',
              style: Theme.of(context).textTheme.titleMedium,
            ),
            _Contributors(uid: uid),
          ],
        ),
      ),
    );
  }

  Future<void> _follow(WidgetRef ref, bool follow) async {
    await ref.read(accountRepo).follow(uid, follow);
    ref.invalidate(userProvider(uid));
  }
}

class _Contributors extends ConsumerWidget {
  const _Contributors({required this.uid});
  final String uid;
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final list = ref.watch(_contributorsProvider(uid));
    return list.when(
      loading: () => const Padding(
        padding: EdgeInsets.all(16),
        child: Center(child: CircularProgressIndicator()),
      ),
      error: (e, _) => const SizedBox.shrink(),
      data: (items) => items.isEmpty
          ? const Padding(
              padding: EdgeInsets.all(16),
              child: Text(
                'No gifts yet this week',
                style: TextStyle(color: BBColors.inkSubtle),
              ),
            )
          : Column(
              children: [
                for (final c in items.where((c) => c.user != null).take(10))
                  UserTile(
                    user: c.user!,
                    trailing: DiamondAmount(c.diamonds, compact: true),
                  ),
              ],
            ),
    );
  }
}

/// Tappable user card inside a live room: follow, profile, report, moderation.
class UserCardSheet extends ConsumerWidget {
  const UserCardSheet({
    super.key,
    required this.user,
    required this.roomId,
    this.canModerate = false,
  });
  final UserBrief user;
  final String roomId;
  final bool canModerate;

  static Future<void> show(
    BuildContext context,
    UserBrief user, {
    required String roomId,
    bool canModerate = false,
  }) => showModalBottomSheet<void>(
    context: context,
    builder: (_) =>
        UserCardSheet(user: user, roomId: roomId, canModerate: canModerate),
  );

  @override
  Widget build(BuildContext context, WidgetRef ref) => SafeArea(
    child: Padding(
      padding: const EdgeInsets.fromLTRB(20, 0, 20, 16),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          BBAvatar(
            url: user.avatarUrl,
            name: user.displayName,
            size: 72,
            vip: user.vipTier > 0,
            frameUrl: user.frameUrl,
          ),
          const SizedBox(height: 8),
          Text(user.displayName, style: Theme.of(context).textTheme.titleLarge),
          const SizedBox(height: 4),
          Row(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              Text(
                'ID ${user.shortId}',
                style: const TextStyle(color: BBColors.inkMuted),
              ),
              const SizedBox(width: 8),
              LevelBadge(user.level),
              const SizedBox(width: 6),
              VipBadge(user.vipTier),
            ],
          ),
          const SizedBox(height: 16),
          Row(
            children: [
              Expanded(
                child: OutlinedButton(
                  onPressed: () => context
                    ..pop()
                    ..push('/user/${user.id}'),
                  child: const Text('Profile'),
                ),
              ),
              const SizedBox(width: 10),
              Expanded(
                child: GoldButton(
                  label: 'Follow',
                  height: 48,
                  onPressed: () async {
                    await ref
                        .read(accountRepo)
                        .follow(user.id, true)
                        .catchError((Object _) {});
                    if (context.mounted) context.pop();
                  },
                ),
              ),
            ],
          ),
          Row(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              TextButton(
                onPressed: () => ReportSheet.show(
                  context,
                  targetType: 'user',
                  targetId: user.id,
                ),
                child: const Text('Report'),
              ),
              if (canModerate) ...[
                TextButton(
                  onPressed: () async {
                    await ref.read(liveRepo).kick(roomId, user.id).catchError((
                      Object e,
                    ) {
                      if (context.mounted) showError(context, e);
                    });
                    if (context.mounted) context.pop();
                  },
                  child: const Text(
                    'Remove from live',
                    style: TextStyle(color: BBColors.danger),
                  ),
                ),
                TextButton(
                  onPressed: () async {
                    await ref
                        .read(liveRepo)
                        .setModerator(roomId, user.id, true)
                        .catchError((Object _) {});
                    if (context.mounted) context.pop();
                  },
                  child: const Text('Make moderator'),
                ),
              ],
            ],
          ),
        ],
      ),
    ),
  );
}

/// Report flow used for users, rooms, posts and comments.
class ReportSheet extends ConsumerStatefulWidget {
  const ReportSheet({
    super.key,
    required this.targetType,
    required this.targetId,
  });
  final String targetType;
  final String targetId;

  static Future<void> show(
    BuildContext context, {
    required String targetType,
    required String targetId,
  }) => showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    builder: (_) => Padding(
      padding: EdgeInsets.only(bottom: MediaQuery.viewInsetsOf(context).bottom),
      child: ReportSheet(targetType: targetType, targetId: targetId),
    ),
  );

  @override
  ConsumerState<ReportSheet> createState() => _ReportSheetState();
}

class _ReportSheetState extends ConsumerState<ReportSheet> {
  static const reasons = {
    'spam': 'Spam or scam',
    'harassment': 'Harassment or bullying',
    'nudity': 'Nudity or sexual content',
    'violence': 'Violence',
    'hate': 'Hate speech',
    'underage': 'Underage user',
    'other': 'Something else',
  };
  String _reason = 'spam';
  final _details = TextEditingController();
  bool _busy = false;

  @override
  void dispose() {
    _details.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => SafeArea(
    child: Padding(
      padding: const EdgeInsets.fromLTRB(20, 0, 20, 16),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('Report', style: Theme.of(context).textTheme.titleLarge),
          const SizedBox(height: 8),
          RadioGroup<String>(
            groupValue: _reason,
            onChanged: (v) => setState(() => _reason = v ?? 'spam'),
            child: Column(
              children: [
                for (final e in reasons.entries)
                  RadioListTile<String>(
                    value: e.key,
                    title: Text(e.value),
                    dense: true,
                    contentPadding: EdgeInsets.zero,
                  ),
              ],
            ),
          ),
          TextField(
            controller: _details,
            maxLength: 1000,
            maxLines: 3,
            decoration: const InputDecoration(
              hintText: 'Anything else we should know? (optional)',
            ),
          ),
          const SizedBox(height: 8),
          GoldButton(
            label: 'Submit report',
            loading: _busy,
            onPressed: () async {
              setState(() => _busy = true);
              try {
                await ref
                    .read(accountRepo)
                    .report(
                      targetType: widget.targetType,
                      targetId: widget.targetId,
                      reason: _reason,
                      details: _details.text.trim(),
                    );
                if (context.mounted) {
                  context.pop();
                  showMessage(
                    context,
                    'Thanks — our team will review this within 24 hours.',
                  );
                }
              } catch (e) {
                if (context.mounted) showError(context, e);
              } finally {
                if (mounted) setState(() => _busy = false);
              }
            },
          ),
        ],
      ),
    ),
  );
}

class FollowListScreen extends ConsumerWidget {
  const FollowListScreen({
    super.key,
    required this.uid,
    required this.direction,
  });
  final String uid;
  final String direction;

  @override
  Widget build(BuildContext context, WidgetRef ref) => Scaffold(
    appBar: AppBar(
      title: Text(direction == 'followers' ? 'Followers' : 'Following'),
    ),
    body: PagedList<UserBrief>(
      load: (cursor) =>
          ref.read(accountRepo).follows(uid, direction, cursor: cursor),
      itemBuilder: (context, u) =>
          UserTile(user: u, onTap: () => context.push('/user/${u.id}')),
      empty: const EmptyState(
        icon: Icons.people_outline,
        title: 'Nobody here yet',
      ),
    ),
  );
}

class SearchScreen extends ConsumerStatefulWidget {
  const SearchScreen({super.key});
  @override
  ConsumerState<SearchScreen> createState() => _SearchScreenState();
}

class _SearchScreenState extends ConsumerState<SearchScreen> {
  List<UserBrief>? _results;
  Timer? _debounce;

  @override
  void dispose() {
    _debounce?.cancel();
    super.dispose();
  }

  void _onChanged(String q) {
    _debounce?.cancel();
    _debounce = Timer(const Duration(milliseconds: 350), () async {
      if (q.trim().isEmpty) return setState(() => _results = null);
      final r = await ref
          .read(accountRepo)
          .search(q.trim())
          .catchError((Object _) => <UserBrief>[]);
      if (mounted) setState(() => _results = r);
    });
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(
      title: TextField(
        autofocus: true,
        onChanged: _onChanged,
        decoration: const InputDecoration(
          hintText: 'Search name or ID',
          prefixIcon: Icon(Icons.search),
        ),
      ),
    ),
    body: _results == null
        ? const EmptyState(
            icon: Icons.person_search_outlined,
            title: 'Find people',
            message: 'Search by display name or BigBoss ID',
          )
        : _results!.isEmpty
        ? const EmptyState(icon: Icons.search_off_rounded, title: 'No matches')
        : ListView(
            children: [
              for (final u in _results!)
                UserTile(user: u, onTap: () => context.push('/user/${u.id}')),
            ],
          ),
  );
}

class SettingsScreen extends ConsumerWidget {
  const SettingsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final cfg = ref.watch(appConfigProvider).value;
    final version = ref.watch(_versionProvider).value;
    return Scaffold(
      appBar: AppBar(title: const Text('Settings')),
      body: ListView(
        children: [
          ListTile(
            leading: const Icon(Icons.edit_outlined),
            title: const Text('Edit profile'),
            onTap: () => context.push('/settings/profile'),
          ),
          ListTile(
            leading: const Icon(Icons.block_outlined),
            title: const Text('Blocked users'),
            onTap: () => context.push('/settings/blocked'),
          ),
          const Divider(),
          ListTile(
            leading: const Icon(Icons.description_outlined),
            title: const Text('Terms of service'),
            onTap: () => launchUrl(
              Uri.parse(cfg?.termsUrl ?? 'https://bigbosslive.app/terms'),
            ),
          ),
          ListTile(
            leading: const Icon(Icons.privacy_tip_outlined),
            title: const Text('Privacy policy'),
            onTap: () => launchUrl(
              Uri.parse(cfg?.privacyUrl ?? 'https://bigbosslive.app/privacy'),
            ),
          ),
          ListTile(
            leading: const Icon(Icons.support_agent_outlined),
            title: const Text('Contact support'),
            onTap: () => launchUrl(
              Uri.parse(
                'mailto:${cfg?.supportEmail ?? 'support@bigbosslive.app'}',
              ),
            ),
          ),
          const Divider(),
          ListTile(
            leading: const Icon(Icons.logout_rounded),
            title: const Text('Sign out'),
            onTap: () async {
              await ref.read(sessionProvider.notifier).signOut();
            },
          ),
          ListTile(
            leading: const Icon(
              Icons.delete_forever_outlined,
              color: BBColors.danger,
            ),
            title: const Text(
              'Delete account',
              style: TextStyle(color: BBColors.danger),
            ),
            subtitle: const Text(
              'Permanently removes your profile and sign-in',
            ),
            onTap: () async {
              final ok = await showDialog<bool>(
                context: context,
                builder: (c) => AlertDialog(
                  title: const Text('Delete your account?'),
                  content: const Text(
                    'Your profile, followers and messages will be removed. Unused diamonds and beans cannot be recovered. This cannot be undone.',
                  ),
                  actions: [
                    TextButton(
                      onPressed: () => c.pop(false),
                      child: const Text('Cancel'),
                    ),
                    FilledButton(
                      style: FilledButton.styleFrom(
                        backgroundColor: BBColors.danger,
                      ),
                      onPressed: () => c.pop(true),
                      child: const Text('Delete'),
                    ),
                  ],
                ),
              );
              if (ok != true) return;
              try {
                await ref.read(accountRepo).deleteAccount();
                await ref.read(sessionProvider.notifier).signOut();
              } catch (e) {
                if (context.mounted) showError(context, e);
              }
            },
          ),
          if (version != null)
            Padding(
              padding: const EdgeInsets.all(24),
              child: Center(
                child: Text(
                  'BigBoss Live ${version.version} (${version.buildNumber})',
                  style: const TextStyle(color: BBColors.inkSubtle),
                ),
              ),
            ),
        ],
      ),
    );
  }
}

class EditProfileScreen extends ConsumerStatefulWidget {
  const EditProfileScreen({super.key});
  @override
  ConsumerState<EditProfileScreen> createState() => _EditProfileScreenState();
}

class _EditProfileScreenState extends ConsumerState<EditProfileScreen> {
  late final MeUser me = ref.read(meProvider);
  late final _name = TextEditingController(text: me.brief.displayName);
  late final _bio = TextEditingController(text: me.profile.bio);
  late String? _gender = me.profile.gender;
  File? _avatar;
  bool _saving = false;

  @override
  void dispose() {
    _name.dispose();
    _bio.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    setState(() => _saving = true);
    try {
      String? avatarUrl;
      if (_avatar != null) {
        avatarUrl = await ref.read(accountRepo).uploadAvatar(_avatar!);
      }
      final updated = await ref.read(accountRepo).updateProfile({
        'displayName': _name.text.trim(),
        'bio': _bio.text.trim(),
        'gender': _gender,
        'avatarUrl': ?avatarUrl,
      });
      ref.read(sessionProvider.notifier).replace(updated);
      if (mounted) context.pop();
    } catch (e) {
      if (mounted) showError(context, e);
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(title: const Text('Edit profile')),
    body: ListView(
      padding: const EdgeInsets.all(20),
      children: [
        Center(
          child: GestureDetector(
            onTap: () async {
              final x = await ImagePicker().pickImage(
                source: ImageSource.gallery,
                maxWidth: 720,
                imageQuality: 85,
              );
              if (x != null) setState(() => _avatar = File(x.path));
            },
            child: Stack(
              children: [
                _avatar != null
                    ? CircleAvatar(
                        radius: 48,
                        backgroundImage: FileImage(_avatar!),
                      )
                    : BBAvatar(
                        url: me.brief.avatarUrl,
                        name: me.brief.displayName,
                        size: 96,
                      ),
                const Positioned(
                  right: 0,
                  bottom: 0,
                  child: CircleAvatar(
                    radius: 16,
                    backgroundColor: BBColors.gold,
                    child: Icon(
                      Icons.camera_alt_rounded,
                      size: 16,
                      color: BBColors.ink,
                    ),
                  ),
                ),
              ],
            ),
          ),
        ),
        const SizedBox(height: 24),
        TextField(
          controller: _name,
          maxLength: 30,
          decoration: const InputDecoration(labelText: 'Display name'),
        ),
        const SizedBox(height: 12),
        TextField(
          controller: _bio,
          maxLength: 160,
          maxLines: 3,
          decoration: const InputDecoration(labelText: 'Bio'),
        ),
        const SizedBox(height: 12),
        DropdownButtonFormField<String?>(
          initialValue: _gender,
          decoration: const InputDecoration(labelText: 'Gender'),
          items: const [
            DropdownMenuItem(value: null, child: Text('Prefer not to say')),
            DropdownMenuItem(value: 'female', child: Text('Female')),
            DropdownMenuItem(value: 'male', child: Text('Male')),
            DropdownMenuItem(value: 'other', child: Text('Other')),
          ],
          onChanged: (v) => setState(() => _gender = v),
        ),
        const SizedBox(height: 24),
        GoldButton(label: 'Save', loading: _saving, onPressed: _save),
      ],
    ),
  );
}

class BlockedUsersScreen extends ConsumerWidget {
  const BlockedUsersScreen({super.key});
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final list = ref.watch(_blockedProvider);
    return Scaffold(
      appBar: AppBar(title: const Text('Blocked users')),
      body: AsyncView(
        value: list,
        data: (items) => items.isEmpty
            ? const EmptyState(
                icon: Icons.block_outlined,
                title: 'You have not blocked anyone',
              )
            : ListView(
                children: [
                  for (final u in items)
                    UserTile(
                      user: u,
                      trailing: TextButton(
                        onPressed: () async {
                          await ref.read(accountRepo).block(u.id, false);
                          ref.invalidate(_blockedProvider);
                        },
                        child: const Text('Unblock'),
                      ),
                    ),
                ],
              ),
      ),
    );
  }
}

class LiveHistoryScreen extends ConsumerWidget {
  const LiveHistoryScreen({super.key});
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final uid = ref.watch(meProvider).id;
    final history = ref.watch(_historyProvider(uid));
    return Scaffold(
      appBar: AppBar(title: const Text('Live history')),
      body: AsyncView(
        value: history,
        data: (j) {
          final items = j.list('items', (e) => e);
          final totals = j.obj('totals');
          return ListView(
            padding: const EdgeInsets.all(16),
            children: [
              Card(
                child: Padding(
                  padding: const EdgeInsets.all(16),
                  child: Row(
                    mainAxisAlignment: MainAxisAlignment.spaceAround,
                    children: [
                      Column(
                        children: [
                          Text(
                            Fmt.duration(totals.integer('seconds')),
                            style: const TextStyle(
                              fontWeight: FontWeight.w800,
                              fontSize: 18,
                            ),
                          ),
                          const Text(
                            'Total live',
                            style: TextStyle(color: BBColors.inkMuted),
                          ),
                        ],
                      ),
                      Column(
                        children: [
                          DiamondAmount(
                            totals.integer('beans'),
                            beans: true,
                            compact: true,
                            style: const TextStyle(fontSize: 18),
                          ),
                          const Text(
                            'Beans earned',
                            style: TextStyle(color: BBColors.inkMuted),
                          ),
                        ],
                      ),
                    ],
                  ),
                ),
              ),
              const SizedBox(height: 12),
              if (items.isEmpty)
                const EmptyState(
                  icon: Icons.history_toggle_off,
                  title: 'No lives yet',
                ),
              for (final s in items)
                ListTile(
                  leading: Icon(
                    s.str('type') == 'audio'
                        ? Icons.mic_rounded
                        : Icons.videocam_rounded,
                    color: BBColors.gold,
                  ),
                  title: Text(s.str('title')),
                  subtitle: Text(
                    '${Fmt.ago(s.date('startedAt'))} · ${Fmt.duration(s.integer('durationSec'))} · peak ${s.integer('peakViewers')}',
                  ),
                  trailing: DiamondAmount(
                    s.integer('giftBeans'),
                    beans: true,
                    compact: true,
                  ),
                ),
            ],
          );
        },
      ),
    );
  }
}
