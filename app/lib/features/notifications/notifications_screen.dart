import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/providers.dart';
import '../../core/router/app_router.dart';
import '../../core/theme/bb_colors.dart';
import '../../core/utils/format.dart';
import '../../core/utils/json.dart';
import '../../core/widgets/widgets.dart';
import '../../models/models.dart';

class NotificationsScreen extends ConsumerStatefulWidget {
  const NotificationsScreen({super.key});
  @override
  ConsumerState<NotificationsScreen> createState() =>
      _NotificationsScreenState();
}

class _NotificationsScreenState extends ConsumerState<NotificationsScreen> {
  bool _marked = false;

  /// Opening the inbox marks everything read, but only after the first page has loaded, so
  /// that page still shows which items are new.
  Future<Paged<AppNotification>> _load(String? cursor) async {
    // The container outlives this screen; the badge must update even if it closes first.
    final container = ProviderScope.containerOf(context, listen: false);
    final page = await ref.read(socialRepo).notifications(cursor: cursor);
    if (!_marked && mounted) {
      _marked = true;
      unawaited(
        ref
            .read(socialRepo)
            .markAllNotificationsRead()
            .then((_) => container.invalidate(unreadProvider))
            .catchError((Object _) {}),
      );
    }
    return page;
  }

  static IconData _icon(String type) => switch (type) {
    'follow' => Icons.person_add_alt_1_rounded,
    'gift' => Icons.card_giftcard_rounded,
    'live' => Icons.live_tv_rounded,
    'like' => Icons.favorite_rounded,
    'comment' => Icons.chat_bubble_rounded,
    'agency' => Icons.groups_2_rounded,
    'withdrawal' => Icons.account_balance_rounded,
    _ => Icons.campaign_rounded,
  };

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(title: const Text('Notifications')),
    body: PagedList<AppNotification>(
      separator: true,
      load: _load,
      empty: const EmptyState(
        icon: Icons.notifications_none_rounded,
        title: 'You\'re all caught up',
      ),
      itemBuilder: (context, n) => ListTile(
        onTap: () {
          final route = routeForLink({
            ...n.data,
            'type': n.data['type'] ?? n.type,
          });
          if (route != null && route != '/notifications') {
            unawaited(context.push(route));
          }
        },
        leading: CircleAvatar(
          backgroundColor: n.type == 'system'
              ? BBColors.ink
              : BBColors.champagne,
          child: Icon(
            _icon(n.type),
            color: n.type == 'system' ? BBColors.goldLight : BBColors.bronze,
            size: 20,
          ),
        ),
        title: Text(
          n.title,
          style: TextStyle(
            fontWeight: n.read ? FontWeight.w500 : FontWeight.w800,
          ),
        ),
        subtitle: Text(n.body),
        trailing: Text(
          Fmt.ago(n.createdAt),
          style: const TextStyle(color: BBColors.inkSubtle, fontSize: 11),
        ),
      ),
    ),
  );
}
