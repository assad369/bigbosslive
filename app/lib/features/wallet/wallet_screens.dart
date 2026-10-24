import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:in_app_purchase/in_app_purchase.dart';

import '../../core/providers.dart';
import '../../core/theme/bb_colors.dart';
import '../../core/utils/format.dart';
import '../../core/utils/json.dart';
import '../../core/widgets/widgets.dart';
import '../../models/models.dart';

final _packagesProvider = FutureProvider.autoDispose(
  (ref) => ref.watch(economyRepo).packages(),
);
final _withdrawalsProvider = FutureProvider.autoDispose(
  (ref) => ref.watch(economyRepo).withdrawals(),
);

class WalletScreen extends ConsumerStatefulWidget {
  const WalletScreen({super.key});
  @override
  ConsumerState<WalletScreen> createState() => _WalletScreenState();
}

class _WalletScreenState extends ConsumerState<WalletScreen> {
  final _iap = InAppPurchase.instance;
  StreamSubscription<List<PurchaseDetails>>? _purchases;
  Map<String, ProductDetails> _products = {};
  bool _storeAvailable = false;
  String? _buying;

  @override
  void initState() {
    super.initState();
    _purchases = _iap.purchaseStream.listen(
      _onPurchases,
      onError: (Object e) => _done(error: e),
    );
    unawaited(_loadStore());
  }

  @override
  void dispose() {
    _purchases?.cancel();
    super.dispose();
  }

  Future<void> _loadStore() async {
    final available = await _iap.isAvailable();
    final packages = await ref
        .read(_packagesProvider.future)
        .catchError((Object _) => <RechargePackage>[]);
    if (!available || packages.isEmpty) {
      if (mounted) setState(() => _storeAvailable = available);
      return;
    }
    final res = await _iap.queryProductDetails(
      packages.map((p) => p.sku).toSet(),
    );
    if (mounted) {
      setState(() {
        _storeAvailable = true;
        _products = {for (final p in res.productDetails) p.id: p};
      });
    }
  }

  Future<void> _buy(RechargePackage pkg) async {
    final product = _products[pkg.sku];
    if (product == null) {
      return showMessage(
        context,
        'This package is not available in your store',
      );
    }
    setState(() => _buying = pkg.sku);
    // The server verifies and consumes the purchase; never consume on the client first.
    final started = await _iap.buyConsumable(
      purchaseParam: PurchaseParam(productDetails: product),
      autoConsume: !Platform.isAndroid,
    );
    if (!started) _done();
  }

  /// Every purchase update — including ones interrupted by an app kill — is verified by the
  /// server before diamonds appear, then completed so the store stops redelivering it.
  Future<void> _onPurchases(List<PurchaseDetails> updates) async {
    for (final p in updates) {
      switch (p.status) {
        case PurchaseStatus.pending:
          continue;
        case PurchaseStatus.canceled:
          _done();
        case PurchaseStatus.error:
          _done(error: p.error?.message ?? 'Purchase failed');
        case PurchaseStatus.purchased || PurchaseStatus.restored:
          try {
            final repo = ref.read(economyRepo);
            final res = Platform.isAndroid
                ? await repo.verifyGoogle(
                    p.productID,
                    p.verificationData.serverVerificationData,
                  )
                : await repo.verifyApple(p.purchaseID ?? '');
            await ref.read(sessionProvider.notifier).refresh();
            if (mounted && res.integer('credited') > 0) {
              showMessage(
                context,
                '💎 ${Fmt.full(res.integer('credited'))} diamonds added',
              );
            }
            _done();
          } catch (e) {
            _done(error: e);
          }
      }
      if (p.pendingCompletePurchase) {
        await _iap.completePurchase(p).catchError((Object _) {});
      }
    }
  }

  void _done({Object? error}) {
    if (!mounted) return;
    setState(() => _buying = null);
    if (error != null) showError(context, error);
  }

  @override
  Widget build(BuildContext context) {
    final me = ref.watch(meProvider);
    final packages = ref.watch(_packagesProvider);
    return Scaffold(
      appBar: AppBar(
        title: const Text('Wallet'),
        actions: [
          TextButton(
            onPressed: () => context.push('/wallet/ledger'),
            child: const Text('History'),
          ),
        ],
      ),
      body: RefreshIndicator(
        onRefresh: () => ref.read(sessionProvider.notifier).refresh(),
        child: ListView(
          padding: const EdgeInsets.all(16),
          children: [
            Container(
              padding: const EdgeInsets.all(20),
              decoration: BoxDecoration(
                gradient: BBColors.goldGradient,
                borderRadius: BorderRadius.circular(22),
                boxShadow: const [
                  BoxShadow(
                    color: Color(0x40B8860B),
                    blurRadius: 20,
                    offset: Offset(0, 8),
                  ),
                ],
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Text(
                    'Diamonds',
                    style: TextStyle(
                      color: BBColors.bronzeDeep,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                  const SizedBox(height: 6),
                  DiamondAmount(
                    me.wallet.diamonds,
                    style: const TextStyle(fontSize: 32, color: BBColors.ink),
                  ),
                  const SizedBox(height: 16),
                  Row(
                    children: [
                      const Text(
                        'Beans  ',
                        style: TextStyle(color: BBColors.bronzeDeep),
                      ),
                      DiamondAmount(
                        me.wallet.beans,
                        beans: true,
                        style: const TextStyle(color: BBColors.ink),
                      ),
                      const Spacer(),
                      TextButton(
                        style: TextButton.styleFrom(
                          foregroundColor: BBColors.ink,
                        ),
                        onPressed: () => context.push('/wallet/withdraw'),
                        child: const Text('Withdraw →'),
                      ),
                    ],
                  ),
                ],
              ),
            ),
            const SizedBox(height: 20),
            Text('Recharge', style: Theme.of(context).textTheme.titleMedium),
            const SizedBox(height: 8),
            if (!_storeAvailable)
              const Card(
                child: Padding(
                  padding: EdgeInsets.all(14),
                  child: Text(
                    'The app store is not available on this device. You can also recharge through an official BigBoss agent.',
                    style: TextStyle(color: BBColors.inkMuted),
                  ),
                ),
              ),
            packages.when(
              loading: () => const Padding(
                padding: EdgeInsets.all(24),
                child: Center(child: CircularProgressIndicator()),
              ),
              error: (e, _) => ErrorView(
                error: e,
                onRetry: () => ref.invalidate(_packagesProvider),
              ),
              data: (items) => GridView.count(
                crossAxisCount: 3,
                shrinkWrap: true,
                physics: const NeverScrollableScrollPhysics(),
                mainAxisSpacing: 10,
                crossAxisSpacing: 10,
                childAspectRatio: 0.9,
                children: [
                  for (final p in items)
                    InkWell(
                      borderRadius: BorderRadius.circular(16),
                      onTap: _buying != null || !_storeAvailable
                          ? null
                          : () => _buy(p),
                      child: Container(
                        decoration: BoxDecoration(
                          color: BBColors.surface,
                          borderRadius: BorderRadius.circular(16),
                          border: Border.all(color: BBColors.champagneDeep),
                        ),
                        padding: const EdgeInsets.all(8),
                        child: Column(
                          mainAxisAlignment: MainAxisAlignment.center,
                          children: [
                            const Text('💎', style: TextStyle(fontSize: 26)),
                            Text(
                              Fmt.full(p.diamonds),
                              style: const TextStyle(
                                fontWeight: FontWeight.w800,
                                fontSize: 16,
                              ),
                            ),
                            if (p.bonusDiamonds > 0)
                              Text(
                                '+${Fmt.full(p.bonusDiamonds)} bonus',
                                style: const TextStyle(
                                  color: BBColors.success,
                                  fontSize: 11,
                                  fontWeight: FontWeight.w700,
                                ),
                              ),
                            const SizedBox(height: 4),
                            _buying == p.sku
                                ? const SizedBox(
                                    width: 16,
                                    height: 16,
                                    child: CircularProgressIndicator(
                                      strokeWidth: 2,
                                    ),
                                  )
                                : Text(
                                    _products[p.sku]?.price ??
                                        Fmt.usd(p.priceUsd),
                                    style: const TextStyle(
                                      color: BBColors.bronze,
                                      fontWeight: FontWeight.w700,
                                    ),
                                  ),
                          ],
                        ),
                      ),
                    ),
                ],
              ),
            ),
            const SizedBox(height: 16),
            const Text(
              'Diamonds are a virtual currency for gifts and features in BigBoss Live. They have no cash value and cannot be exchanged.',
              style: TextStyle(color: BBColors.inkSubtle, fontSize: 12),
            ),
          ],
        ),
      ),
    );
  }
}

class LedgerScreen extends ConsumerStatefulWidget {
  const LedgerScreen({super.key});
  @override
  ConsumerState<LedgerScreen> createState() => _LedgerScreenState();
}

class _LedgerScreenState extends ConsumerState<LedgerScreen> {
  String? _currency;

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(title: const Text('Transactions')),
    body: Column(
      children: [
        Padding(
          padding: const EdgeInsets.all(12),
          child: SegmentedButton<String?>(
            segments: const [
              ButtonSegment(value: null, label: Text('All')),
              ButtonSegment(value: 'diamonds', label: Text('Diamonds')),
              ButtonSegment(value: 'beans', label: Text('Beans')),
            ],
            selected: {_currency},
            onSelectionChanged: (s) => setState(() => _currency = s.first),
          ),
        ),
        Expanded(
          child: PagedList<LedgerEntry>(
            key: ValueKey(_currency),
            separator: true,
            load: (cursor) => ref
                .read(economyRepo)
                .ledger(currency: _currency, cursor: cursor),
            empty: const EmptyState(
              icon: Icons.receipt_long_outlined,
              title: 'No transactions yet',
            ),
            itemBuilder: (_, e) => ListTile(
              leading: CircleAvatar(
                backgroundColor: BBColors.champagne,
                child: Text(e.currency == 'beans' ? '🫘' : '💎'),
              ),
              title: Text(e.label[0].toUpperCase() + e.label.substring(1)),
              subtitle: Text(Fmt.ago(e.createdAt)),
              trailing: Column(
                mainAxisAlignment: MainAxisAlignment.center,
                crossAxisAlignment: CrossAxisAlignment.end,
                children: [
                  Text(
                    '${e.delta > 0 ? '+' : ''}${Fmt.full(e.delta)}',
                    style: TextStyle(
                      fontWeight: FontWeight.w800,
                      color: e.delta > 0 ? BBColors.success : BBColors.danger,
                    ),
                  ),
                  Text(
                    'bal ${Fmt.compact(e.balanceAfter)}',
                    style: const TextStyle(
                      color: BBColors.inkSubtle,
                      fontSize: 11,
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      ],
    ),
  );
}

class WithdrawScreen extends ConsumerStatefulWidget {
  const WithdrawScreen({super.key});
  @override
  ConsumerState<WithdrawScreen> createState() => _WithdrawScreenState();
}

class _WithdrawScreenState extends ConsumerState<WithdrawScreen> {
  final _beans = TextEditingController();
  final _provider = TextEditingController(text: 'bKash');
  final _number = TextEditingController();
  final _name = TextEditingController();
  String _method = 'mobile_wallet';
  bool _busy = false;

  @override
  void dispose() {
    for (final c in [_beans, _provider, _number, _name]) {
      c.dispose();
    }
    super.dispose();
  }

  Future<void> _submit() async {
    final beans = int.tryParse(_beans.text.trim()) ?? 0;
    if (beans <= 0 ||
        _number.text.trim().isEmpty ||
        _name.text.trim().isEmpty) {
      return showMessage(context, 'Fill in the amount and your payout details');
    }
    setState(() => _busy = true);
    try {
      final res = await ref
          .read(economyRepo)
          .requestWithdrawal(
            beans: beans,
            method: _method,
            account: {
              'provider': _provider.text.trim(),
              'number': _number.text.trim(),
              'name': _name.text.trim(),
            },
          );
      await ref.read(sessionProvider.notifier).refresh();
      ref.invalidate(_withdrawalsProvider);
      _beans.clear();
      if (mounted) {
        showMessage(
          context,
          'Request submitted · ${Fmt.usd(res.dbl('amountUsd'))}. We review within 3 business days.',
        );
      }
    } catch (e) {
      if (mounted) showError(context, e);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final me = ref.watch(meProvider);
    final history = ref.watch(_withdrawalsProvider);
    return Scaffold(
      appBar: AppBar(title: const Text('Withdraw beans')),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          Card(
            child: ListTile(
              title: const Text('Available'),
              trailing: DiamondAmount(
                me.wallet.beans,
                beans: true,
                style: const TextStyle(fontSize: 18),
              ),
            ),
          ),
          const SizedBox(height: 16),
          TextField(
            controller: _beans,
            keyboardType: TextInputType.number,
            inputFormatters: [FilteringTextInputFormatter.digitsOnly],
            decoration: const InputDecoration(labelText: 'Beans to withdraw'),
          ),
          const SizedBox(height: 12),
          DropdownButtonFormField<String>(
            initialValue: _method,
            decoration: const InputDecoration(labelText: 'Method'),
            items: const [
              DropdownMenuItem(
                value: 'mobile_wallet',
                child: Text('Mobile wallet'),
              ),
              DropdownMenuItem(value: 'bank', child: Text('Bank transfer')),
              DropdownMenuItem(value: 'paypal', child: Text('PayPal')),
            ],
            onChanged: (v) => setState(() => _method = v ?? 'mobile_wallet'),
          ),
          const SizedBox(height: 12),
          TextField(
            controller: _provider,
            decoration: InputDecoration(
              labelText: _method == 'bank'
                  ? 'Bank name'
                  : _method == 'paypal'
                  ? 'PayPal'
                  : 'Provider (bKash, Nagad…)',
            ),
          ),
          const SizedBox(height: 12),
          TextField(
            controller: _number,
            decoration: InputDecoration(
              labelText: _method == 'paypal'
                  ? 'PayPal email'
                  : 'Account number',
            ),
          ),
          const SizedBox(height: 12),
          TextField(
            controller: _name,
            decoration: const InputDecoration(labelText: 'Account holder name'),
          ),
          const SizedBox(height: 20),
          GoldButton(
            label: 'Request withdrawal',
            loading: _busy,
            onPressed: _submit,
          ),
          const SizedBox(height: 24),
          Text('Requests', style: Theme.of(context).textTheme.titleMedium),
          history.when(
            loading: () => const Padding(
              padding: EdgeInsets.all(16),
              child: Center(child: CircularProgressIndicator()),
            ),
            error: (e, _) => Text(e.toString()),
            data: (items) => Column(
              children: [
                if (items.isEmpty)
                  const Padding(
                    padding: EdgeInsets.all(16),
                    child: Text(
                      'No requests yet',
                      style: TextStyle(color: BBColors.inkSubtle),
                    ),
                  ),
                for (final w in items)
                  ListTile(
                    contentPadding: EdgeInsets.zero,
                    title: Text(
                      '${Fmt.full(w.integer('beans'))} beans · ${Fmt.usd(w.dbl('amountUsd'))}',
                    ),
                    subtitle: Text(Fmt.ago(w.date('createdAt'))),
                    trailing: Chip(label: Text(w.str('status'))),
                  ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

/// Agent (reseller) tool: look up a user by BigBoss ID and transfer diamonds from stock.
class AgentRechargeScreen extends ConsumerStatefulWidget {
  const AgentRechargeScreen({super.key});
  @override
  ConsumerState<AgentRechargeScreen> createState() =>
      _AgentRechargeScreenState();
}

class _AgentRechargeScreenState extends ConsumerState<AgentRechargeScreen> {
  final _id = TextEditingController();
  final _amount = TextEditingController();
  UserBrief? _target;
  bool _busy = false;

  @override
  void dispose() {
    _id.dispose();
    _amount.dispose();
    super.dispose();
  }

  Future<void> _lookup() async {
    try {
      final u = await ref.read(economyRepo).agentLookup(_id.text.trim());
      setState(() => _target = u);
    } catch (e) {
      setState(() => _target = null);
      if (mounted) showError(context, e);
    }
  }

  Future<void> _recharge() async {
    final amount = int.tryParse(_amount.text.trim()) ?? 0;
    final target = _target;
    if (target == null || amount <= 0) return;
    final ok = await showDialog<bool>(
      context: context,
      builder: (c) => AlertDialog(
        title: const Text('Confirm recharge'),
        content: Text(
          'Send 💎 ${Fmt.full(amount)} to ${target.displayName} (ID ${target.shortId})?',
        ),
        actions: [
          TextButton(
            onPressed: () => c.pop(false),
            child: const Text('Cancel'),
          ),
          FilledButton(onPressed: () => c.pop(true), child: const Text('Send')),
        ],
      ),
    );
    if (ok != true) return;
    setState(() => _busy = true);
    try {
      await ref.read(economyRepo).agentRecharge(target.id, amount);
      await ref.read(sessionProvider.notifier).refresh();
      _amount.clear();
      if (mounted) showMessage(context, 'Recharged ${target.displayName}');
    } catch (e) {
      if (mounted) showError(context, e);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final me = ref.watch(meProvider);
    return Scaffold(
      appBar: AppBar(title: const Text('Agent recharge')),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          Card(
            child: ListTile(
              title: const Text('Your stock'),
              trailing: DiamondAmount(
                me.wallet.agentStock,
                style: const TextStyle(fontSize: 18),
              ),
            ),
          ),
          const SizedBox(height: 16),
          TextField(
            controller: _id,
            keyboardType: TextInputType.number,
            decoration: InputDecoration(
              labelText: 'User BigBoss ID',
              suffixIcon: IconButton(
                onPressed: _lookup,
                icon: const Icon(Icons.search),
              ),
            ),
            onSubmitted: (_) => _lookup(),
          ),
          if (_target != null)
            Padding(
              padding: const EdgeInsets.only(top: 8),
              child: Card(child: UserTile(user: _target!)),
            ),
          const SizedBox(height: 12),
          TextField(
            controller: _amount,
            keyboardType: TextInputType.number,
            inputFormatters: [FilteringTextInputFormatter.digitsOnly],
            decoration: const InputDecoration(labelText: 'Diamonds'),
          ),
          const SizedBox(height: 20),
          GoldButton(
            label: 'Recharge',
            loading: _busy,
            onPressed: _target == null ? null : _recharge,
          ),
        ],
      ),
    );
  }
}
