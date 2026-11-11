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

class StoreScreen extends ConsumerWidget {
  const StoreScreen({super.key});

  /// Mirrors `STORE_COSMETIC_TYPES` in `packages/shared` (chat bubbles aren't sold yet).
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

/// The busy key for wearing or taking off items of [type]. One per slot, shared by the
/// store tabs and Mine, so the same slot is never changed from two places at once.
String _slotKey(String type) => 'equip:$type';

/// Puts [item] on ([wear]) or takes it off, then refreshes the store, Mine and the session
/// (the profile's frame). Returns whether it ran. Everything it needs from [ref] is read
/// before the first `await`: the tab may be gone by the time the server answers.
Future<bool> _setWorn(
  BuildContext context,
  WidgetRef ref,
  StoreItem item, {
  required bool wear,
}) async {
  final actions = ref.read(_actionsProvider.notifier);
  final repo = ref.read(economyRepo);
  final session = ref.read(sessionProvider.notifier);
  final container = ProviderScope.containerOf(context, listen: false);
  try {
    final ran = await actions.run(_slotKey(item.type), (_) async {
      await repo.equip(wear ? item.id : null, item.type);
      container
        ..invalidate(_ownedProvider)
        ..invalidate(_itemsProvider(item.type));
      await session.refresh();
    });
    if (ran && context.mounted) {
      showMessage(
        context,
        wear ? '${item.name} equipped' : '${item.name} taken off',
      );
    }
    return ran;
  } catch (e) {
    if (context.mounted) showError(context, e);
    return false;
  }
}

/// The tier the user holds now (0 = none).
int _myTier(WidgetRef ref) =>
    ref.read(sessionProvider).value?.brief.vipTier ?? 0;

/// Sends someone without the right tier to the tier packages, with the reason.
Future<void> _needsTier(BuildContext context, StoreItem item) async {
  showMessage(
    context,
    item.vipIncluded
        ? 'Included with ${VipBadge.labelFor(item.vipTierRequired)}'
        : 'Requires ${VipBadge.labelFor(item.vipTierRequired)}',
  );
  await context.push('/vip');
}

class _StoreGrid extends ConsumerWidget {
  const _StoreGrid({required this.type});
  final String type;

  Future<void> _buy(BuildContext context, WidgetRef ref, StoreItem item) async {
    if (!await _confirmSpend(context, item.name, item.priceDiamonds)) return;
    if (!context.mounted) return;
    final actions = ref.read(_actionsProvider.notifier);
    final repo = ref.read(economyRepo);
    final session = ref.read(sessionProvider.notifier);
    final container = ProviderScope.containerOf(context, listen: false);
    final messenger = ScaffoldMessenger.of(context);
    try {
      final ran = await actions.run('item:${item.id}', (key) async {
        await repo.buyItem(item.id, idempotencyKey: key);
        await session.refresh();
      });
      container
        ..invalidate(_ownedProvider)
        ..invalidate(_itemsProvider(item.type));
      if (!ran || !context.mounted) return;
      messenger
        ..hideCurrentSnackBar()
        ..showSnackBar(
          SnackBar(
            content: Text('${item.name} is yours'),
            action: item.wearable && !item.equipped
                ? SnackBarAction(
                    label: 'Equip',
                    onPressed: () {
                      if (context.mounted) {
                        _setWorn(context, ref, item, wear: true);
                      }
                    },
                  )
                : null,
          ),
        );
    } catch (e) {
      if (context.mounted) await _handlePurchaseError(context, e);
    }
  }

  Future<void> _onTap(
    BuildContext context,
    WidgetRef ref,
    StoreItem item,
  ) async {
    final locked = item.vipTierRequired > _myTier(ref);
    if (item.vipIncluded) {
      // A tier perk is never bought: holders wear it, others see the tiers.
      if (locked) return _needsTier(context, item);
      if (!item.wearable) {
        return showMessage(context, '${item.name} is in Mine');
      }
      await _setWorn(context, ref, item, wear: !item.equipped);
      return;
    }
    if (item.owned) {
      await _OwnedItemSheet.show(
        context,
        item: item,
        canExtend: !locked,
        onWear: (wear) => _setWorn(context, ref, item, wear: wear),
        onExtend: () => _buy(context, ref, item),
      );
      return;
    }
    if (locked) return _needsTier(context, item);
    await _buy(context, ref, item);
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
                  final working =
                      busy.contains('item:${item.id}') ||
                      busy.contains(_slotKey(item.type));
                  return StoreItemTile(
                    item: item,
                    busy: working,
                    onTap: working ? null : () => _onTap(context, ref, item),
                  );
                },
              ),
      ),
    );
  }
}

/// One store item: its picture, name, terms, and the caller's own state (Equipped, Owned)
/// or its price.
class StoreItemTile extends StatelessWidget {
  const StoreItemTile({
    super.key,
    required this.item,
    this.onTap,
    this.busy = false,
  });
  final StoreItem item;
  final VoidCallback? onTap;
  final bool busy;

  @override
  Widget build(BuildContext context) {
    final terms = item.vipIncluded
        ? '${VipBadge.labelFor(item.vipTierRequired)} perk'
        : item.owned && item.ownedUntil != null
        ? 'Until ${Fmt.date(item.ownedUntil!)}'
        : '${item.durationDays} days${item.vipTierRequired > 0 ? ' · ${VipBadge.labelFor(item.vipTierRequired)}+' : ''}';
    return Card(
      shape: item.equipped
          ? RoundedRectangleBorder(
              borderRadius: BorderRadius.circular(18),
              side: const BorderSide(color: BBColors.gold, width: 2),
            )
          : null,
      child: InkWell(
        borderRadius: BorderRadius.circular(18),
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.all(12),
          child: Column(
            children: [
              Expanded(child: CosmeticPreview(item: item)),
              Text(
                item.name,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(fontWeight: FontWeight.w700),
              ),
              Text(
                terms,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(color: BBColors.inkSubtle, fontSize: 12),
              ),
              const SizedBox(height: 6),
              if (busy)
                const SizedBox.square(
                  dimension: 18,
                  child: CircularProgressIndicator(strokeWidth: 2),
                )
              else if (item.equipped)
                const _StateLabel('Equipped', BBColors.success)
              else if (item.owned)
                const _StateLabel('Owned', BBColors.goldDeep)
              else if (item.vipIncluded)
                const _StateLabel('Included', BBColors.gold)
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
  }
}

class _StateLabel extends StatelessWidget {
  const _StateLabel(this.text, this.color);
  final String text;
  final Color color;

  @override
  Widget build(BuildContext context) => FittedBox(
    fit: BoxFit.scaleDown,
    child: Text(
      text,
      style: TextStyle(color: color, fontWeight: FontWeight.w700),
    ),
  );
}

/// What a store item looks like: a frame drawn by [FrameView] (animated) when it has no
/// still preview, a background as its picture, otherwise the preview image.
class CosmeticPreview extends StatelessWidget {
  const CosmeticPreview({super.key, required this.item, this.size});
  final StoreItem item;

  /// Fixed square size (list rows); null fills the available space (grid tiles).
  final double? size;

  @override
  Widget build(BuildContext context) {
    const fallback = Icon(Icons.auto_awesome, color: BBColors.gold, size: 40);
    final preview = item.previewUrl;
    Widget image(String url) => CachedNetworkImage(
      imageUrl: url,
      fit: BoxFit.contain,
      errorWidget: (_, _, _) => fallback,
    );
    final Widget child;
    if (preview != null) {
      child = image(preview);
    } else if (item.type == 'frame') {
      child = LayoutBuilder(
        builder: (_, box) => FrameView(
          url: item.assetUrl,
          format: item.animationFormat,
          size: size ?? box.biggest.shortestSide,
        ),
      );
    } else if (item.type == 'room_background' &&
        item.animationFormat == 'none') {
      child = image(item.assetUrl);
    } else {
      child = fallback;
    }
    return size == null
        ? child
        : SizedBox.square(dimension: size, child: child);
  }
}

/// Plays an entrance effect or shows a background full screen, once.
Future<void> showCosmeticPreview(BuildContext context, StoreItem item) =>
    showDialog<void>(
      context: context,
      barrierColor: BBColors.espressoShade,
      builder: (ctx) => GestureDetector(
        onTap: () => Navigator.pop(ctx),
        child: SizedBox.expand(
          child:
              item.type == 'room_background' && item.animationFormat == 'none'
              ? CachedNetworkImage(imageUrl: item.assetUrl, fit: BoxFit.cover)
              : EffectView(
                  url: item.assetUrl,
                  format: item.animationFormat,
                  fit: item.type == 'room_background'
                      ? BoxFit.cover
                      : BoxFit.contain,
                  onDone: () {
                    if (ctx.mounted) Navigator.pop(ctx);
                  },
                ),
        ),
      ),
    );

/// An item the user already holds, tapped in the store: wear it (or take it off), preview
/// it, or extend it by buying it again.
class _OwnedItemSheet extends StatelessWidget {
  const _OwnedItemSheet({
    required this.item,
    required this.canExtend,
    required this.onWear,
    required this.onExtend,
  });
  final StoreItem item;
  final bool canExtend;
  final Future<bool> Function(bool wear) onWear;
  final Future<void> Function() onExtend;

  static Future<void> show(
    BuildContext context, {
    required StoreItem item,
    required bool canExtend,
    required Future<bool> Function(bool wear) onWear,
    required Future<void> Function() onExtend,
  }) => showModalBottomSheet<void>(
    context: context,
    builder: (_) => _OwnedItemSheet(
      item: item,
      canExtend: canExtend,
      onWear: onWear,
      onExtend: onExtend,
    ),
  );

  @override
  Widget build(BuildContext context) => SafeArea(
    child: Padding(
      padding: const EdgeInsets.fromLTRB(20, 0, 20, 16),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          SizedBox(height: 120, child: CosmeticPreview(item: item)),
          const SizedBox(height: 8),
          Text(
            item.name,
            textAlign: TextAlign.center,
            style: Theme.of(context).textTheme.titleMedium,
          ),
          if (item.ownedUntil != null)
            Text(
              'Yours until ${Fmt.dateTime(item.ownedUntil!)}',
              textAlign: TextAlign.center,
              style: const TextStyle(color: BBColors.inkMuted),
            ),
          const SizedBox(height: 16),
          if (item.wearable)
            GoldButton(
              label: item.equipped ? 'Take off' : 'Equip',
              onPressed: () {
                Navigator.pop(context);
                onWear(!item.equipped);
              },
            ),
          if (item.type != 'frame') ...[
            const SizedBox(height: 8),
            OutlinedButton(
              onPressed: () => showCosmeticPreview(context, item),
              child: const Text('Preview'),
            ),
          ],
          if (canExtend) ...[
            const SizedBox(height: 8),
            OutlinedButton(
              onPressed: () {
                Navigator.pop(context);
                onExtend();
              },
              child: Text(
                'Extend ${item.durationDays} days · 💎 ${Fmt.full(item.priceDiamonds)}',
              ),
            ),
          ],
        ],
      ),
    ),
  );
}

class _OwnedList extends ConsumerWidget {
  const _OwnedList();

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
                leading: CosmeticPreview(item: o.item, size: 44),
                onTap: o.item.type == 'frame'
                    ? null
                    : () => showCosmeticPreview(context, o.item),
                title: Text(
                  o.item.name,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
                subtitle: Text(
                  [
                    if (o.viaVip)
                      '${VipBadge.labelFor(o.item.vipTierRequired)} perk',
                    o.expiresAt == null
                        ? 'Never expires'
                        : '${o.viaVip ? 'Until' : 'Expires'} ${Fmt.relative(o.expiresAt)}',
                  ].join(' · '),
                ),
                trailing: o.item.wearable
                    ? _EquipButton(
                        equipped: o.equipped,
                        busy: busy.contains(_slotKey(o.item.type)),
                        onPressed: () =>
                            _setWorn(context, ref, o.item, wear: !o.equipped),
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
