import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/network/api_client.dart';
import '../../core/network/api_exception.dart';
import '../../core/providers.dart';
import '../../core/theme/bb_colors.dart';
import '../../core/utils/format.dart';
import '../../core/vip_tier.dart';
import '../../core/widgets/tier_badge.dart';
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

/// "KING Package", "CROWN Package", …: the name of one tier's shop.
String tierPackageTitle(VipTier t) => '${t.label.toUpperCase()} Package';

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
          title: Text(
            tierPackageTitle(t),
            style: const TextStyle(fontWeight: FontWeight.w600),
          ),
          trailing: const Icon(Icons.chevron_right),
          onTap: () => context.push('/vip/${t.name}'),
        ),
    ],
  );
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

/// One button on a package card. [busyKey] is its `_actionsProvider` id.
class _Action {
  const _Action(
    this.label, {
    required this.busyKey,
    this.onTap,
    this.outlined = false,
  });
  final String label;
  final String busyKey;
  final VoidCallback? onTap;
  final bool outlined;
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
  String get _title => tierPackageTitle(widget.tier);
  String get _upper => widget.tier.label.toUpperCase();

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
        'Not enough diamonds — you need ${Fmt.full(p.priceDiamonds - balance)} more.',
      );
      await context.push('/wallet');
      return;
    }
    final ok =
        await showDialog<bool>(
          context: context,
          builder: (c) => AlertDialog(
            title: Text(owned ? 'Extend ${p.name}?' : 'Buy ${p.name}?'),
            content: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                DiamondAmount(
                  p.priceDiamonds,
                  style: const TextStyle(
                    fontSize: 16,
                    fontWeight: FontWeight.w700,
                  ),
                ),
                Text(
                  '  ·  +${p.durationDays} days',
                  style: const TextStyle(color: BBColors.inkMuted),
                ),
              ],
            ),
            actions: [
              TextButton(
                onPressed: () => Navigator.pop(c, false),
                child: const Text('Cancel'),
              ),
              FilledButton(
                onPressed: () => Navigator.pop(c, true),
                child: Text(owned ? 'Extend' : 'Buy'),
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
      showMessage(
        context,
        owned ? '${p.name} extended' : '${p.name} purchased & in use',
      );
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
          id == null ? 'Package taken off' : 'Package in use',
        );
      }
    } catch (e) {
      if (mounted) showError(context, e);
    }
  }

  /// The buttons for a package: Buy when not held, else Extend (while on sale) and Use /
  /// In use. Tapping In use takes it off.
  List<_Action> _actionsFor(
    TierPackage p,
    OwnedTierPackage? owned, {
    required bool onSale,
  }) {
    final buyKey = 'buy:${p.id}';
    if (owned == null) {
      return [
        _Action('Buy', busyKey: buyKey, onTap: () => _buy(p, owned: false)),
      ];
    }
    return [
      if (onSale && (owned.expired || p.priceDiamonds > 0))
        _Action(
          owned.expired ? 'Buy' : 'Extend',
          busyKey: buyKey,
          onTap: () => _buy(p, owned: !owned.expired),
        ),
      if (owned.worn)
        _Action(
          'In use',
          busyKey: 'wear:off',
          outlined: true,
          onTap: () => _wear(null),
        )
      else
        _Action(
          'Use',
          busyKey: 'wear:${p.id}',
          onTap: owned.expired ? null : () => _wear(p.id),
        ),
    ];
  }

  /// "In use · Until …", "Until …" or "Expired" for a held package.
  (String, Color)? _ownershipLine(OwnedTierPackage? o) {
    if (o == null) return null;
    if (o.expired) return ('Expired', BBColors.danger);
    final until = o.expiresAt == null
        ? 'No expiry'
        : 'Until ${Fmt.dateTime(o.expiresAt!)}';
    return ('${o.worn ? 'In use · ' : ''}$until', BBColors.goldDeep);
  }

  void _preview(TierPackage p, List<_Action> actions, UserBrief me) {
    showDialog<void>(
      context: context,
      builder: (c) => Dialog(
        backgroundColor: BBColors.ivory,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(20)),
        child: Padding(
          padding: const EdgeInsets.fromLTRB(20, 24, 20, 20),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              BBAvatar(
                url: me.avatarUrl,
                name: me.displayName,
                size: 120,
                badge: p.badge,
              ),
              if (p.badge != null) ...[
                const SizedBox(height: 16),
                TierBadgeView(badge: p.badge!, size: 120),
              ],
              const SizedBox(height: 16),
              Text(
                p.name,
                textAlign: TextAlign.center,
                style: const TextStyle(
                  fontSize: 17,
                  fontWeight: FontWeight.w700,
                ),
              ),
              const SizedBox(height: 6),
              VipBadge(p.tier),
              const SizedBox(height: 10),
              DiamondAmount(
                p.priceDiamonds,
                style: const TextStyle(
                  fontSize: 16,
                  fontWeight: FontWeight.w700,
                ),
              ),
              const SizedBox(height: 2),
              Text(
                '${p.durationDays} days validity',
                style: const TextStyle(
                  fontSize: 13.5,
                  color: BBColors.inkMuted,
                ),
              ),
              const SizedBox(height: 16),
              Wrap(
                spacing: 8,
                runSpacing: 8,
                alignment: WrapAlignment.center,
                children: [
                  OutlinedButton(
                    onPressed: () => Navigator.pop(c),
                    style: _ActionButton.style(outlined: true),
                    child: const Text('Close'),
                  ),
                  for (final a in actions)
                    if (!a.outlined)
                      FilledButton(
                        onPressed: a.onTap == null
                            ? null
                            : () {
                                Navigator.pop(c);
                                a.onTap!();
                              },
                        style: _ActionButton.style(outlined: false),
                        child: Text(a.label),
                      ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final me = ref.watch(meProvider);
    return Scaffold(
      appBar: AppBar(
        title: Text(_title),
        actions: [
          Padding(
            padding: const EdgeInsetsDirectional.only(end: 16),
            child: Center(
              child: DiamondAmount(
                me.wallet.diamonds,
                style: const TextStyle(
                  fontSize: 16,
                  fontWeight: FontWeight.w600,
                ),
              ),
            ),
          ),
        ],
        bottom: TabBar(
          controller: _tabs,
          tabs: [
            const Tab(
              icon: Icon(Icons.storefront_outlined, size: 18),
              text: 'Shop',
            ),
            Tab(
              icon: const Icon(Icons.inventory_2_outlined, size: 18),
              text: 'My $_upper',
            ),
          ],
        ),
      ),
      body: TabBarView(
        controller: _tabs,
        children: [_shop(me.brief), _mine(me.brief)],
      ),
    );
  }

  Widget _shop(UserBrief me) {
    final shop = ref.watch(_shopProvider(_tier));
    final mine = ref.watch(_mineProvider(_tier)).value ?? const [];
    final busy = ref.watch(_actionsProvider);
    final held = {
      for (final o in mine)
        if (!o.expired) o.package.id: o,
    };
    return AsyncView(
      value: shop,
      onRetry: () => ref.invalidate(_shopProvider(_tier)),
      data: (items) => RefreshIndicator(
        onRefresh: _refreshAll,
        child: items.isEmpty
            ? _empty('No $_upper packages available yet')
            : ListView(
                physics: const AlwaysScrollableScrollPhysics(),
                padding: const EdgeInsets.fromLTRB(16, 8, 16, 32),
                children: [
                  _heading('$_title:'),
                  for (final p in items)
                    _card(me, p, held[p.id], onSale: true, busy: busy),
                ],
              ),
      ),
    );
  }

  Widget _mine(UserBrief me) {
    final mine = ref.watch(_mineProvider(_tier));
    final shop = ref.watch(_shopProvider(_tier)).value ?? const [];
    final busy = ref.watch(_actionsProvider);
    final onSale = {for (final p in shop) p.id};
    return AsyncView(
      value: mine,
      onRetry: () => ref.invalidate(_mineProvider(_tier)),
      data: (items) => RefreshIndicator(
        onRefresh: _refreshAll,
        child: items.isEmpty
            ? _empty(
                "You don't own any $_upper packages yet.\nVisit the shop to buy one.",
              )
            : ListView(
                physics: const AlwaysScrollableScrollPhysics(),
                padding: const EdgeInsets.fromLTRB(16, 8, 16, 32),
                children: [
                  _heading('My $_title:'),
                  for (final o in items)
                    _card(
                      me,
                      o.package,
                      o,
                      onSale: onSale.contains(o.package.id),
                      busy: busy,
                    ),
                ],
              ),
      ),
    );
  }

  Widget _card(
    UserBrief me,
    TierPackage p,
    OwnedTierPackage? owned, {
    required bool onSale,
    required Set<String> busy,
  }) {
    final actions = _actionsFor(p, owned, onSale: onSale);
    return _PackageCard(
      package: p,
      worn: owned?.worn ?? false,
      ownership: _ownershipLine(owned),
      actions: actions,
      busy: busy,
      onPreview: () => _preview(p, actions, me),
    );
  }

  Widget _heading(String text) => Padding(
    padding: const EdgeInsets.only(bottom: 10),
    child: Text(
      text,
      style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w600),
    ),
  );

  Widget _empty(String message) => ListView(
    physics: const AlwaysScrollableScrollPhysics(),
    children: [
      const SizedBox(height: 80),
      EmptyState(icon: widget.tier.icon, title: message),
    ],
  );
}

/// One package: its badge in a gold ring (tap to preview), price, validity, what the user
/// holds of it, and its buttons.
class _PackageCard extends StatelessWidget {
  const _PackageCard({
    required this.package,
    required this.worn,
    required this.ownership,
    required this.actions,
    required this.busy,
    required this.onPreview,
  });

  final TierPackage package;
  final bool worn;
  final (String, Color)? ownership;
  final List<_Action> actions;
  final Set<String> busy;
  final VoidCallback onPreview;

  @override
  Widget build(BuildContext context) {
    final tier = VipTier.of(package.tier);
    final line = ownership;
    return Container(
      margin: const EdgeInsets.only(bottom: 10),
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        gradient: const LinearGradient(
          colors: [BBColors.surface, BBColors.surfaceMuted],
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
        ),
        borderRadius: BorderRadius.circular(16),
        border: Border.all(
          color: worn ? tier.color : BBColors.border,
          width: worn ? 1.6 : 1,
        ),
      ),
      child: Row(
        children: [
          GestureDetector(
            onTap: onPreview,
            child: _Thumb(package: package, tier: tier),
          ),
          const SizedBox(width: 14),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Flexible(
                      child: Text(
                        package.name,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(
                          fontWeight: FontWeight.w700,
                          fontSize: 14,
                        ),
                      ),
                    ),
                    const SizedBox(width: 6),
                    VipBadge(package.tier, dense: true),
                  ],
                ),
                const SizedBox(height: 4),
                DiamondAmount(
                  package.priceDiamonds,
                  style: const TextStyle(
                    fontSize: 16,
                    fontWeight: FontWeight.w700,
                  ),
                ),
                const SizedBox(height: 2),
                Text(
                  '${package.durationDays} days validity',
                  style: const TextStyle(
                    fontSize: 13.5,
                    color: BBColors.inkMuted,
                  ),
                ),
                if (line != null)
                  Text(line.$1, style: TextStyle(fontSize: 13, color: line.$2)),
                const SizedBox(height: 10),
                Wrap(
                  spacing: 8,
                  runSpacing: 8,
                  children: [
                    for (final a in actions)
                      _ActionButton(a, busy: busy.contains(a.busyKey)),
                  ],
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

/// A 68px gold-ringed circle with the package's badge, or the tier icon without artwork.
class _Thumb extends StatelessWidget {
  const _Thumb({required this.package, required this.tier});
  final TierPackage package;
  final VipTier tier;

  @override
  Widget build(BuildContext context) {
    final badge = package.badge;
    return Container(
      width: 68,
      height: 68,
      decoration: BoxDecoration(
        shape: BoxShape.circle,
        color: BBColors.surfaceMuted,
        gradient: badge == null ? tier.gradient : null,
        border: Border.all(color: BBColors.gold, width: 2),
      ),
      alignment: Alignment.center,
      child: badge == null
          ? Icon(tier.icon, color: BBColors.onAccent, size: 30)
          : TierBadgeView(badge: badge, size: 52),
    );
  }
}

class _ActionButton extends StatelessWidget {
  const _ActionButton(this.action, {required this.busy});
  final _Action action;
  final bool busy;

  static ButtonStyle style({required bool outlined}) {
    const size = Size(76, 40);
    const padding = EdgeInsets.symmetric(horizontal: 16);
    const text = TextStyle(fontSize: 14, fontWeight: FontWeight.w600);
    return outlined
        ? OutlinedButton.styleFrom(
            minimumSize: size,
            padding: padding,
            textStyle: text,
          )
        : FilledButton.styleFrom(
            minimumSize: size,
            padding: padding,
            textStyle: text,
          );
  }

  @override
  Widget build(BuildContext context) {
    final onTap = busy ? null : action.onTap;
    final child = busy
        ? const SizedBox.square(
            dimension: 18,
            child: CircularProgressIndicator(strokeWidth: 2),
          )
        : Text(action.label);
    return SizedBox(
      height: 40,
      child: action.outlined
          ? OutlinedButton(
              onPressed: onTap,
              style: style(outlined: true),
              child: child,
            )
          : FilledButton(
              onPressed: onTap,
              style: style(outlined: false),
              child: child,
            ),
    );
  }
}
