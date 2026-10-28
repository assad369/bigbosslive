import 'package:cached_network_image/cached_network_image.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/network/api_client.dart';
import '../../core/network/api_exception.dart';
import '../../core/providers.dart';
import '../../core/theme/bb_colors.dart';
import '../../core/utils/format.dart';
import '../../core/widgets/frame_view.dart';
import '../../core/widgets/widgets.dart';
import '../../models/models.dart';

final _vipProvider = FutureProvider.autoDispose(
  (ref) => ref.watch(economyRepo).vipPackages(),
);
final _itemsProvider = FutureProvider.autoDispose.family(
  (ref, String type) => ref.watch(economyRepo).storeItems(type: type),
);
final _ownedProvider = FutureProvider.autoDispose(
  (ref) => ref.watch(economyRepo).owned(),
);

/// Store actions in flight, by id. A purchase keeps its idempotency key until it succeeds,
/// so retrying after a timeout (which may have gone through) never charges twice.
final _actionsProvider = NotifierProvider.autoDispose<_Actions, Set<String>>(
  _Actions.new,
);

class _Actions extends Notifier<Set<String>> {
  final _keys = <String, String>{};

  @override
  Set<String> build() => const {};

  /// Runs [action] unless the same [id] is already running. False if it was.
  Future<bool> run(String id, Future<void> Function(String key) action) async {
    if (state.contains(id)) return false;
    state = {...state, id};
    final key = _keys[id] ??= ApiClient.newIdempotencyKey();
    try {
      await action(key);
      _keys.remove(id);
      return true;
    } finally {
      if (ref.mounted) state = {...state}..remove(id);
    }
  }
}

Future<bool> _confirmSpend(
  BuildContext context,
  String what,
  int price,
) async =>
    await showDialog<bool>(
      context: context,
      builder: (c) => AlertDialog(
        title: Text('Buy $what?'),
        content: Text('This costs 💎 ${Fmt.full(price)}.'),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(c, false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(c, true),
            child: const Text('Buy'),
          ),
        ],
      ),
    ) ??
    false;

Future<void> _handlePurchaseError(BuildContext context, Object e) async {
  if (e is ApiException && e.insufficientBalance) {
    showMessage(context, 'Not enough diamonds');
    await context.push('/wallet');
  } else {
    showError(context, e);
  }
}

class VipScreen extends ConsumerWidget {
  const VipScreen({super.key});

  Future<void> _buy(BuildContext context, WidgetRef ref, VipPackage p) async {
    if (!await _confirmSpend(context, p.name, p.priceDiamonds)) return;
    if (!context.mounted) return;
    try {
      final ran = await ref.read(_actionsProvider.notifier).run('vip:${p.id}', (
        key,
      ) async {
        await ref.read(economyRepo).buyVip(p.id, idempotencyKey: key);
        await ref.read(sessionProvider.notifier).refresh();
      });
      if (ran && context.mounted) {
        showMessage(context, 'Welcome to ${p.name} 👑');
      }
    } catch (e) {
      if (context.mounted) await _handlePurchaseError(context, e);
    }
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final me = ref.watch(meProvider);
    final packages = ref.watch(_vipProvider);
    final busy = ref.watch(_actionsProvider);
    return Scaffold(
      appBar: AppBar(title: const Text('VIP')),
      body: AsyncView(
        value: packages,
        onRetry: () => ref.invalidate(_vipProvider),
        data: (items) => RefreshIndicator(
          onRefresh: () async {
            ref.invalidate(_vipProvider);
            await ref.read(sessionProvider.notifier).refresh();
          },
          child: ListView(
            padding: const EdgeInsets.all(16),
            children: [
              if (me.brief.vipTier > 0)
                Card(
                  child: ListTile(
                    leading: VipBadge(me.brief.vipTier),
                    title: const Text('Your membership'),
                    subtitle: Text(
                      me.vipExpiresAt == null
                          ? ''
                          : 'Active until ${Fmt.date(me.vipExpiresAt!)}',
                    ),
                  ),
                ),
              for (final p in items)
                Container(
                  margin: const EdgeInsets.only(top: 14),
                  padding: const EdgeInsets.all(18),
                  decoration: BoxDecoration(
                    gradient:
                        BBColors.tierGradient(p.tier) ?? BBColors.goldGradient,
                    borderRadius: BorderRadius.circular(22),
                  ),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(
                        children: [
                          // Preview of the tier's frame on the buyer's own avatar.
                          Padding(
                            padding: const EdgeInsets.all(
                              48 * BBAvatar.frameOverhang,
                            ),
                            child: BBAvatar(
                              url: me.brief.avatarUrl,
                              name: me.brief.displayName,
                              size: 48,
                              frameUrl: p.frameUrl,
                              frameFormat: p.frameFormat,
                              vipTier: p.tier,
                            ),
                          ),
                          const SizedBox(width: 8),
                          Expanded(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text(
                                  p.name,
                                  maxLines: 1,
                                  overflow: TextOverflow.ellipsis,
                                  style: Theme.of(context).textTheme.titleLarge
                                      ?.copyWith(color: BBColors.ivory),
                                ),
                                VipBadge(p.tier, dense: true),
                              ],
                            ),
                          ),
                          const SizedBox(width: 8),
                          Text(
                            '${p.durationDays} days',
                            style: const TextStyle(color: BBColors.champagne),
                          ),
                        ],
                      ),
                      const SizedBox(height: 10),
                      for (final perk in p.perks)
                        Padding(
                          padding: const EdgeInsets.symmetric(vertical: 2),
                          child: Text(
                            '✦  $perk',
                            style: const TextStyle(color: BBColors.ivory),
                          ),
                        ),
                      const SizedBox(height: 14),
                      Row(
                        children: [
                          Expanded(
                            child: Align(
                              alignment: AlignmentDirectional.centerStart,
                              child: FittedBox(
                                fit: BoxFit.scaleDown,
                                child: DiamondAmount(
                                  p.priceDiamonds,
                                  style: const TextStyle(
                                    color: BBColors.ivory,
                                    fontSize: 18,
                                  ),
                                ),
                              ),
                            ),
                          ),
                          const SizedBox(width: 8),
                          FilledButton(
                            style: FilledButton.styleFrom(
                              backgroundColor: BBColors.ivory,
                              foregroundColor: BBColors.ink,
                              minimumSize: const Size(110, 44),
                            ),
                            onPressed:
                                me.brief.vipTier > p.tier ||
                                    busy.contains('vip:${p.id}')
                                ? null
                                : () => _buy(context, ref, p),
                            child: busy.contains('vip:${p.id}')
                                ? const SizedBox.square(
                                    dimension: 18,
                                    child: CircularProgressIndicator(
                                      strokeWidth: 2,
                                    ),
                                  )
                                : Text(
                                    me.brief.vipTier == p.tier
                                        ? 'Renew'
                                        : 'Get',
                                  ),
                          ),
                        ],
                      ),
                    ],
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }
}

class StoreScreen extends ConsumerWidget {
  const StoreScreen({super.key});

  static const tabs = [
    ('frame', 'Frames'),
    ('entry_animation', 'Entries'),
    ('room_background', 'Backgrounds'),
  ];

  @override
  Widget build(BuildContext context, WidgetRef ref) => DefaultTabController(
    length: tabs.length + 1,
    child: Scaffold(
      appBar: AppBar(
        title: const Text('Store'),
        bottom: TabBar(
          tabs: [
            for (final t in tabs) Tab(text: t.$2),
            const Tab(text: 'Mine'),
          ],
        ),
      ),
      body: TabBarView(
        children: [
          for (final t in tabs) _StoreGrid(type: t.$1),
          const _OwnedList(),
        ],
      ),
    ),
  );
}

class _StoreGrid extends ConsumerWidget {
  const _StoreGrid({required this.type});
  final String type;

  Future<void> _buy(BuildContext context, WidgetRef ref, StoreItem item) async {
    if (!await _confirmSpend(context, item.name, item.priceDiamonds)) return;
    if (!context.mounted) return;
    try {
      final ran = await ref.read(_actionsProvider.notifier).run(
        'item:${item.id}',
        (key) async {
          await ref.read(economyRepo).buyItem(item.id, idempotencyKey: key);
          await ref.read(sessionProvider.notifier).refresh();
        },
      );
      ref.invalidate(_ownedProvider);
      if (ran && context.mounted) {
        showMessage(context, '${item.name} added — equip it in Mine');
      }
    } catch (e) {
      if (context.mounted) await _handlePurchaseError(context, e);
    }
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final items = ref.watch(_itemsProvider(type));
    final busy = ref.watch(_actionsProvider);
    final text = MediaQuery.textScalerOf(context);
    return AsyncView(
      value: items,
      onRetry: () => ref.invalidate(_itemsProvider(type)),
      data: (list) => RefreshIndicator(
        onRefresh: () async => ref.invalidate(_itemsProvider(type)),
        child: list.isEmpty
            ? ListView(
                physics: const AlwaysScrollableScrollPhysics(),
                children: const [
                  SizedBox(height: 80),
                  EmptyState(
                    icon: Icons.storefront_outlined,
                    title: 'Nothing in store yet',
                  ),
                ],
              )
            : GridView.builder(
                physics: const AlwaysScrollableScrollPhysics(),
                padding: const EdgeInsets.all(12),
                // Preview area plus three text lines that grow with the user's text size.
                gridDelegate: SliverGridDelegateWithMaxCrossAxisExtent(
                  maxCrossAxisExtent: 220,
                  mainAxisSpacing: 12,
                  crossAxisSpacing: 12,
                  mainAxisExtent: 140 + text.scale(66),
                ),
                itemCount: list.length,
                itemBuilder: (_, i) {
                  final item = list[i];
                  final buying = busy.contains('item:${item.id}');
                  return Card(
                    child: InkWell(
                      borderRadius: BorderRadius.circular(18),
                      onTap: buying ? null : () => _buy(context, ref, item),
                      child: Padding(
                        padding: const EdgeInsets.all(12),
                        child: Column(
                          children: [
                            Expanded(
                              child:
                                  item.previewUrl == null &&
                                      item.type == 'frame'
                                  // No still preview: show the frame itself, animated.
                                  ? LayoutBuilder(
                                      builder: (_, box) => FrameView(
                                        url: item.assetUrl,
                                        format: item.animationFormat,
                                        size: box.biggest.shortestSide,
                                      ),
                                    )
                                  : item.previewUrl != null
                                  ? CachedNetworkImage(
                                      imageUrl: item.previewUrl!,
                                      errorWidget: (_, _, _) => const Icon(
                                        Icons.auto_awesome,
                                        color: BBColors.gold,
                                        size: 48,
                                      ),
                                    )
                                  : const Icon(
                                      Icons.auto_awesome,
                                      color: BBColors.gold,
                                      size: 48,
                                    ),
                            ),
                            Text(
                              item.name,
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: const TextStyle(
                                fontWeight: FontWeight.w700,
                              ),
                            ),
                            Text(
                              '${item.durationDays} days${item.vipTierRequired > 0 ? ' · ${VipBadge.labelFor(item.vipTierRequired)}+' : ''}',
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: const TextStyle(
                                color: BBColors.inkSubtle,
                                fontSize: 12,
                              ),
                            ),
                            const SizedBox(height: 6),
                            if (buying)
                              const SizedBox.square(
                                dimension: 18,
                                child: CircularProgressIndicator(
                                  strokeWidth: 2,
                                ),
                              )
                            else
                              FittedBox(
                                fit: BoxFit.scaleDown,
                                child: DiamondAmount(item.priceDiamonds),
                              ),
                          ],
                        ),
                      ),
                    ),
                  );
                },
              ),
      ),
    );
  }
}

class _OwnedList extends ConsumerWidget {
  const _OwnedList();

  Future<void> _equip(
    BuildContext context,
    WidgetRef ref,
    String? itemId,
    String type,
  ) async {
    try {
      await ref.read(_actionsProvider.notifier).run('equip:$type', (_) async {
        await ref.read(economyRepo).equip(itemId, type);
        ref.invalidate(_ownedProvider);
        await ref.read(sessionProvider.notifier).refresh();
      });
    } catch (e) {
      if (context.mounted) showError(context, e);
    }
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final owned = ref.watch(_ownedProvider);
    final busy = ref.watch(_actionsProvider);
    return AsyncView(
      value: owned,
      onRetry: () => ref.invalidate(_ownedProvider),
      data: (items) => RefreshIndicator(
        onRefresh: () async => ref.invalidate(_ownedProvider),
        child: ListView(
          physics: const AlwaysScrollableScrollPhysics(),
          children: [
            if (items.isEmpty) ...[
              const SizedBox(height: 80),
              const EmptyState(
                icon: Icons.inventory_2_outlined,
                title: 'You don\'t own anything yet',
              ),
            ],
            for (final o in items)
              ListTile(
                leading: o.item.previewUrl != null
                    ? CachedNetworkImage(
                        imageUrl: o.item.previewUrl!,
                        width: 44,
                      )
                    : const Icon(Icons.auto_awesome, color: BBColors.gold),
                title: Text(
                  o.item.name,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
                subtitle: Text(
                  o.expiresAt == null
                      ? 'Never expires'
                      : 'Expires ${Fmt.relative(o.expiresAt)}',
                ),
                trailing:
                    o.item.type == 'frame' || o.item.type == 'entry_animation'
                    ? _EquipButton(
                        equipped: o.equipped,
                        busy: busy.contains('equip:${o.item.type}'),
                        onPressed: () => _equip(
                          context,
                          ref,
                          o.equipped ? null : o.item.id,
                          o.item.type,
                        ),
                      )
                    : null,
              ),
          ],
        ),
      ),
    );
  }
}

class _EquipButton extends StatelessWidget {
  const _EquipButton({
    required this.equipped,
    required this.busy,
    required this.onPressed,
  });
  final bool equipped;
  final bool busy;
  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) {
    final child = busy
        ? const SizedBox.square(
            dimension: 16,
            child: CircularProgressIndicator(strokeWidth: 2),
          )
        : Text(equipped ? 'Unequip' : 'Equip');
    return equipped
        ? OutlinedButton(onPressed: busy ? null : onPressed, child: child)
        : FilledButton(onPressed: busy ? null : onPressed, child: child);
  }
}
