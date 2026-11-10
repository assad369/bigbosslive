import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/network/api_client.dart';
import '../../core/network/api_exception.dart';
import '../../core/providers.dart';
import '../../core/theme/bb_colors.dart';
import '../../core/utils/format.dart';
import '../../core/vip_tier.dart';
import '../../core/widgets/widgets.dart';
import '../../models/models.dart';

final _shopProvider = FutureProvider.autoDispose.family(
  (ref, int tier) => ref.watch(economyRepo).tierPackages(tier),
);
final _mineProvider = FutureProvider.autoDispose.family(
  (ref, int tier) => ref.watch(economyRepo).myTierPackages(tier),
);

/// Tier package actions in flight, by id. A purchase keeps its idempotency key until it
/// succeeds, so retrying after a timeout (which may have gone through) never charges twice.
final _actionsProvider =
    NotifierProvider.autoDispose<_TierActions, Set<String>>(_TierActions.new);

class _TierActions extends Notifier<Set<String>> {
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

/// The tiers, highest first, as the Packages section lists them.
const tierLadder = [VipTier.king, VipTier.crown, VipTier.vvip, VipTier.vip];

/// The four tier shop entries (King, Crown, VVIP, VIP), for the profile and the hub.
class TierPackageTiles extends StatelessWidget {
  const TierPackageTiles({super.key});

  @override
  Widget build(BuildContext context) => Column(
    children: [
      for (final t in tierLadder)
        ListTile(
          leading: Container(
            width: 36,
            height: 36,
            decoration: BoxDecoration(
              gradient: t.gradient,
              shape: BoxShape.circle,
            ),
            child: Icon(t.icon, color: BBColors.onAccent, size: 20),
          ),
          title: Text('${t.label} Packages'),
          subtitle: Text(_subtitle(t)),
          trailing: const Icon(Icons.chevron_right),
          onTap: () => context.push('/vip/${t.name}'),
        ),
    ],
  );

  static String _subtitle(VipTier t) => switch (t) {
    VipTier.king => 'The top tier · first in every list',
    VipTier.crown => 'Crown badges · above VVIP',
    VipTier.vvip => 'VVIP badges · above VIP',
    _ => 'VIP badge & perks',
  };
}

/// `/vip`: pick a tier's shop.
class TierPackagesHub extends StatelessWidget {
  const TierPackagesHub({super.key});

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(title: const Text('Packages')),
    body: ListView(
      padding: const EdgeInsets.symmetric(vertical: 8),
      children: const [
        Padding(
          padding: EdgeInsets.fromLTRB(16, 8, 16, 8),
          child: Text(
            'A package is a badge on your avatar. Buy as many as you like and wear one at a '
            'time: it sets your tier while it lasts.',
            style: TextStyle(color: BBColors.inkMuted),
          ),
        ),
        TierPackageTiles(),
      ],
    ),
  );
}

/// `/vip/:tier`: one tier's shop and the user's packages of that tier.
class TierPackagesScreen extends ConsumerStatefulWidget {
  const TierPackagesScreen({super.key, required this.tier});
  final VipTier tier;

  @override
  ConsumerState<TierPackagesScreen> createState() => _TierPackagesScreenState();
}

class _TierPackagesScreenState extends ConsumerState<TierPackagesScreen>
    with SingleTickerProviderStateMixin {
  late final TabController _tabs = TabController(length: 2, vsync: this);

  int get _tier => widget.tier.number;
  String get _label => widget.tier.label;

  @override
  void dispose() {
    _tabs.dispose();
    super.dispose();
  }

  Future<void> _refreshAll() async {
    ref
      ..invalidate(_shopProvider(_tier))
      ..invalidate(_mineProvider(_tier));
    await ref.read(sessionProvider.notifier).refresh();
  }

  Future<void> _buy(TierPackage p, {required bool owned}) async {
    final balance = ref.read(meProvider).wallet.diamonds;
    if (balance < p.priceDiamonds) {
      showMessage(
        context,
        'Insufficient diamonds — you need ${Fmt.full(p.priceDiamonds - balance)} more.',
      );
      await context.push('/wallet');
      return;
    }
    final ok =
        await showDialog<bool>(
          context: context,
          builder: (c) => AlertDialog(
            title: Text(owned ? 'Renew ${p.name}?' : 'Buy ${p.name}?'),
            content: Text(
              'This will deduct 💎 ${Fmt.full(p.priceDiamonds)}. Your $_label package will be '
              '${owned ? 'extended by' : 'active for'} ${p.durationDays} days.',
            ),
            actions: [
              TextButton(
                onPressed: () => Navigator.pop(c, false),
                child: const Text('Cancel'),
              ),
              FilledButton(
                onPressed: () => Navigator.pop(c, true),
                child: const Text('Confirm'),
              ),
            ],
          ),
        ) ??
        false;
    if (!ok || !mounted) return;
    try {
      final ran = await ref.read(_actionsProvider.notifier).run('buy:${p.id}', (
        key,
      ) async {
        await ref.read(economyRepo).buyTierPackage(p.id, idempotencyKey: key);
      });
      if (!ran || !mounted) return;
      await _refreshAll();
      if (!mounted) return;
      showMessage(context, '${p.name} purchased & activated');
      _tabs.animateTo(1);
    } catch (e) {
      if (!mounted) return;
      if (e is ApiException && e.insufficientBalance) {
        showMessage(context, 'Not enough diamonds');
        await context.push('/wallet');
      } else {
        showError(context, e);
      }
    }
  }

  Future<void> _wear(String? id) async {
    try {
      final ran = await ref
          .read(_actionsProvider.notifier)
          .run(
            'wear:${id ?? 'off'}',
            (_) => ref.read(economyRepo).wearTierPackage(id),
          );
      if (!ran || !mounted) return;
      await _refreshAll();
      if (mounted) {
        showMessage(
          context,
          id == null ? 'Package taken off' : 'Package activated',
        );
      }
    } catch (e) {
      if (mounted) showError(context, e);
    }
  }

  @override
  Widget build(BuildContext context) {
    final me = ref.watch(meProvider);
    return Scaffold(
      appBar: AppBar(
        title: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('$_label Packages'),
            Text(
              widget.tier == VipTier.vip
                  ? 'VIP badge & perks'
                  : '$_label decorations',
              style: const TextStyle(fontSize: 12, color: BBColors.inkMuted),
            ),
          ],
        ),
        bottom: TabBar(
          controller: _tabs,
          tabs: [
            const Tab(
              icon: Icon(Icons.storefront_outlined, size: 18),
              text: 'Shop',
            ),
            Tab(
              icon: const Icon(Icons.inventory_2_outlined, size: 18),
              text: 'My $_label',
            ),
          ],
        ),
      ),
      body: Column(
        children: [
          _BalanceBar(diamonds: me.wallet.diamonds),
          Expanded(
            child: TabBarView(
              controller: _tabs,
              children: [_shop(me), _mine(me)],
            ),
          ),
        ],
      ),
    );
  }

  Widget _shop(MeUser me) {
    final shop = ref.watch(_shopProvider(_tier));
    final mine = ref.watch(_mineProvider(_tier)).value ?? const [];
    final busy = ref.watch(_actionsProvider);
    final owned = {
      for (final o in mine)
        if (!o.expired) o.package.id,
    };
    return AsyncView(
      value: shop,
      onRetry: () => ref.invalidate(_shopProvider(_tier)),
      data: (items) => RefreshIndicator(
        onRefresh: _refreshAll,
        child: items.isEmpty
            ? _empty('No $_label packages available yet')
            : ListView.builder(
                physics: const AlwaysScrollableScrollPhysics(),
                padding: const EdgeInsets.all(16),
                itemCount: items.length,
                itemBuilder: (_, i) {
                  final p = items[i];
                  final has = owned.contains(p.id);
                  final buying = busy.contains('buy:${p.id}');
                  return _PackageRow(
                    me: me.brief,
                    package: p,
                    highlighted: has,
                    subtitle: has
                        ? 'Owned · ${p.durationDays} days'
                        : '${p.durationDays} days',
                    trailing: buying
                        ? const _Spinner()
                        : has
                        ? OutlinedButton.icon(
                            onPressed: () => _buy(p, owned: true),
                            icon: const Icon(Icons.check, size: 16),
                            label: const Text('Owned'),
                          )
                        : FilledButton(
                            onPressed: () => _buy(p, owned: false),
                            child: DiamondAmount(
                              p.priceDiamonds,
                              style: const TextStyle(color: BBColors.onAccent),
                            ),
                          ),
                  );
                },
              ),
      ),
    );
  }

  Widget _mine(MeUser me) {
    final mine = ref.watch(_mineProvider(_tier));
    final busy = ref.watch(_actionsProvider);
    return AsyncView(
      value: mine,
      onRetry: () => ref.invalidate(_mineProvider(_tier)),
      data: (items) {
        final wearing = items.any((o) => o.worn);
        return RefreshIndicator(
          onRefresh: _refreshAll,
          child: items.isEmpty
              ? _empty(
                  "You don't own any $_label packages yet.\nVisit the shop to buy one.",
                )
              : ListView(
                  physics: const AlwaysScrollableScrollPhysics(),
                  padding: const EdgeInsets.all(16),
                  children: [
                    if (wearing)
                      Padding(
                        padding: const EdgeInsets.only(bottom: 12),
                        child: OutlinedButton.icon(
                          style: OutlinedButton.styleFrom(
                            minimumSize: const Size.fromHeight(46),
                          ),
                          onPressed: busy.contains('wear:off')
                              ? null
                              : () => _wear(null),
                          icon: const Icon(Icons.visibility_off_outlined),
                          label: const Text('Deactivate current package'),
                        ),
                      ),
                    for (final o in items)
                      _PackageRow(
                        me: me.brief,
                        package: o.package,
                        highlighted: o.worn,
                        subtitle: o.expired
                            ? 'Expired'
                            : o.expiresAt == null
                            ? 'No expiry'
                            : 'Expires ${Fmt.date(o.expiresAt!)}',
                        subtitleColor: o.expired ? BBColors.danger : null,
                        trailing: o.worn
                            ? const _ActiveChip()
                            : busy.contains('wear:${o.package.id}')
                            ? const _Spinner()
                            : FilledButton(
                                onPressed: o.expired
                                    ? null
                                    : () => _wear(o.package.id),
                                child: const Text('Activate'),
                              ),
                      ),
                  ],
                ),
        );
      },
    );
  }

  Widget _empty(String message) => ListView(
    physics: const AlwaysScrollableScrollPhysics(),
    children: [
      const SizedBox(height: 80),
      EmptyState(icon: widget.tier.icon, title: message),
    ],
  );
}

class _BalanceBar extends StatelessWidget {
  const _BalanceBar({required this.diamonds});
  final int diamonds;

  @override
  Widget build(BuildContext context) => Container(
    margin: const EdgeInsets.fromLTRB(16, 12, 16, 0),
    padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
    decoration: BoxDecoration(
      color: BBColors.surface,
      borderRadius: BorderRadius.circular(16),
      border: Border.all(color: BBColors.goldOutline),
    ),
    child: Row(
      children: [
        const Text('💎', style: TextStyle(fontSize: 20)),
        const SizedBox(width: 8),
        const Text('Balance', style: TextStyle(color: BBColors.inkMuted)),
        const Spacer(),
        DiamondAmount(
          diamonds,
          style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w800),
        ),
      ],
    ),
  );
}

/// One package: the user's own avatar wearing its badge, its name and terms, an action.
class _PackageRow extends StatelessWidget {
  const _PackageRow({
    required this.me,
    required this.package,
    required this.subtitle,
    required this.trailing,
    this.highlighted = false,
    this.subtitleColor,
  });

  final UserBrief me;
  final TierPackage package;
  final String subtitle;
  final Color? subtitleColor;
  final Widget trailing;
  final bool highlighted;

  @override
  Widget build(BuildContext context) {
    final tier = VipTier.of(package.tier);
    return Container(
      margin: const EdgeInsets.only(bottom: 12),
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: BBColors.surface,
        borderRadius: BorderRadius.circular(24),
        border: Border.all(
          color: highlighted ? tier.color : BBColors.goldOutline,
          width: highlighted ? 1.6 : 1,
        ),
        boxShadow: [
          BoxShadow(
            color: tier.color.withValues(alpha: highlighted ? 0.16 : 0.08),
            blurRadius: 16,
          ),
        ],
      ),
      child: Row(
        children: [
          BBAvatar(
            url: me.avatarUrl,
            name: me.displayName,
            size: 56,
            badge: package.badge,
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  package.name,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(
                    fontWeight: FontWeight.w700,
                    fontSize: 15,
                  ),
                ),
                const SizedBox(height: 4),
                Row(
                  children: [
                    VipBadge(package.tier, dense: true),
                    const SizedBox(width: 6),
                    Flexible(
                      child: Text(
                        subtitle,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(
                          fontSize: 12,
                          color: subtitleColor ?? BBColors.inkSubtle,
                        ),
                      ),
                    ),
                  ],
                ),
              ],
            ),
          ),
          const SizedBox(width: 8),
          trailing,
        ],
      ),
    );
  }
}

class _ActiveChip extends StatelessWidget {
  const _ActiveChip();

  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
    decoration: BoxDecoration(
      color: BBColors.champagneTint,
      borderRadius: BorderRadius.circular(10),
      border: Border.all(color: BBColors.gold),
    ),
    child: const Text(
      'Active',
      style: TextStyle(color: BBColors.goldDeep, fontWeight: FontWeight.w700),
    ),
  );
}

class _Spinner extends StatelessWidget {
  const _Spinner();

  @override
  Widget build(BuildContext context) => const Padding(
    padding: EdgeInsets.symmetric(horizontal: 18),
    child: SizedBox.square(
      dimension: 18,
      child: CircularProgressIndicator(strokeWidth: 2),
    ),
  );
}
