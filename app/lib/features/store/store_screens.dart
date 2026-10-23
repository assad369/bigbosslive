import 'package:cached_network_image/cached_network_image.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/network/api_exception.dart';
import '../../core/providers.dart';
import '../../core/theme/bb_colors.dart';
import '../../core/utils/format.dart';
import '../../core/widgets/widgets.dart';

final _vipProvider = FutureProvider.autoDispose(
  (ref) => ref.watch(economyRepo).vipPackages(),
);
final _itemsProvider = FutureProvider.autoDispose.family(
  (ref, String type) => ref.watch(economyRepo).storeItems(type: type),
);
final _ownedProvider = FutureProvider.autoDispose(
  (ref) => ref.watch(economyRepo).owned(),
);

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
            onPressed: () => c.pop(false),
            child: const Text('Cancel'),
          ),
          FilledButton(onPressed: () => c.pop(true), child: const Text('Buy')),
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

  static const _tierGradients = [
    BBColors.bronzeGradient,
    BBColors.goldGradient,
    LinearGradient(colors: [Color(0xFF5C3A00), Color(0xFF2B2118)]),
  ];

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final me = ref.watch(meProvider);
    final packages = ref.watch(_vipProvider);
    return Scaffold(
      appBar: AppBar(title: const Text('VIP')),
      body: AsyncView(
        value: packages,
        onRetry: () => ref.invalidate(_vipProvider),
        data: (items) => ListView(
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
                        : 'Active until ${me.vipExpiresAt!.toLocal().toString().substring(0, 10)}',
                  ),
                ),
              ),
            for (final (i, p) in items.indexed)
              Container(
                margin: const EdgeInsets.only(top: 14),
                padding: const EdgeInsets.all(18),
                decoration: BoxDecoration(
                  gradient: _tierGradients[i % _tierGradients.length],
                  borderRadius: BorderRadius.circular(22),
                ),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        const Icon(
                          Icons.workspace_premium_rounded,
                          color: BBColors.ivory,
                          size: 30,
                        ),
                        const SizedBox(width: 8),
                        Text(
                          p.name,
                          style: Theme.of(context).textTheme.titleLarge
                              ?.copyWith(color: BBColors.ivory),
                        ),
                        const Spacer(),
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
                        DiamondAmount(
                          p.priceDiamonds,
                          style: const TextStyle(
                            color: BBColors.ivory,
                            fontSize: 18,
                          ),
                        ),
                        const Spacer(),
                        FilledButton(
                          style: FilledButton.styleFrom(
                            backgroundColor: BBColors.ivory,
                            foregroundColor: BBColors.ink,
                            minimumSize: const Size(110, 44),
                          ),
                          onPressed: me.brief.vipTier > p.tier
                              ? null
                              : () async {
                                  if (!await _confirmSpend(
                                    context,
                                    p.name,
                                    p.priceDiamonds,
                                  )) {
                                    return;
                                  }
                                  try {
                                    await ref.read(economyRepo).buyVip(p.id);
                                    await ref
                                        .read(sessionProvider.notifier)
                                        .refresh();
                                    if (context.mounted) {
                                      showMessage(
                                        context,
                                        'Welcome to ${p.name} 👑',
                                      );
                                    }
                                  } catch (e) {
                                    if (context.mounted) {
                                      await _handlePurchaseError(context, e);
                                    }
                                  }
                                },
                          child: Text(
                            me.brief.vipTier == p.tier ? 'Renew' : 'Get',
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

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final items = ref.watch(_itemsProvider(type));
    return AsyncView(
      value: items,
      onRetry: () => ref.invalidate(_itemsProvider(type)),
      data: (list) => list.isEmpty
          ? const EmptyState(
              icon: Icons.storefront_outlined,
              title: 'Nothing in store yet',
            )
          : GridView.builder(
              padding: const EdgeInsets.all(12),
              gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
                crossAxisCount: 2,
                mainAxisSpacing: 12,
                crossAxisSpacing: 12,
                childAspectRatio: 0.8,
              ),
              itemCount: list.length,
              itemBuilder: (_, i) {
                final item = list[i];
                return Card(
                  child: InkWell(
                    borderRadius: BorderRadius.circular(18),
                    onTap: () async {
                      if (!await _confirmSpend(
                        context,
                        item.name,
                        item.priceDiamonds,
                      )) {
                        return;
                      }
                      try {
                        await ref.read(economyRepo).buyItem(item.id);
                        await ref.read(sessionProvider.notifier).refresh();
                        ref.invalidate(_ownedProvider);
                        if (context.mounted) {
                          showMessage(
                            context,
                            '${item.name} added — equip it in Mine',
                          );
                        }
                      } catch (e) {
                        if (context.mounted) {
                          await _handlePurchaseError(context, e);
                        }
                      }
                    },
                    child: Padding(
                      padding: const EdgeInsets.all(12),
                      child: Column(
                        children: [
                          Expanded(
                            child: item.previewUrl != null
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
                            style: const TextStyle(fontWeight: FontWeight.w700),
                          ),
                          Text(
                            '${item.durationDays} days${item.vipTierRequired > 0 ? ' · VIP${item.vipTierRequired}+' : ''}',
                            style: const TextStyle(
                              color: BBColors.inkSubtle,
                              fontSize: 12,
                            ),
                          ),
                          const SizedBox(height: 6),
                          DiamondAmount(item.priceDiamonds),
                        ],
                      ),
                    ),
                  ),
                );
              },
            ),
    );
  }
}

class _OwnedList extends ConsumerWidget {
  const _OwnedList();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final owned = ref.watch(_ownedProvider);
    return AsyncView(
      value: owned,
      onRetry: () => ref.invalidate(_ownedProvider),
      data: (items) => items.isEmpty
          ? const EmptyState(
              icon: Icons.inventory_2_outlined,
              title: 'You don\'t own anything yet',
            )
          : ListView(
              children: [
                for (final o in items)
                  ListTile(
                    leading: o.item.previewUrl != null
                        ? CachedNetworkImage(
                            imageUrl: o.item.previewUrl!,
                            width: 44,
                          )
                        : const Icon(Icons.auto_awesome, color: BBColors.gold),
                    title: Text(o.item.name),
                    subtitle: Text(
                      'Expires ${Fmt.ago(o.expiresAt)}'.replaceFirst(
                        'ago',
                        'from now',
                      ),
                    ),
                    trailing:
                        o.item.type == 'frame' ||
                            o.item.type == 'entry_animation'
                        ? (o.equipped
                              ? OutlinedButton(
                                  onPressed: () async {
                                    await ref
                                        .read(economyRepo)
                                        .equip(null, o.item.type);
                                    ref.invalidate(_ownedProvider);
                                    await ref
                                        .read(sessionProvider.notifier)
                                        .refresh();
                                  },
                                  child: const Text('Unequip'),
                                )
                              : FilledButton(
                                  onPressed: () async {
                                    await ref
                                        .read(economyRepo)
                                        .equip(o.item.id, o.item.type);
                                    ref.invalidate(_ownedProvider);
                                    await ref
                                        .read(sessionProvider.notifier)
                                        .refresh();
                                  },
                                  child: const Text('Equip'),
                                ))
                        : null,
                  ),
              ],
            ),
    );
  }
}
