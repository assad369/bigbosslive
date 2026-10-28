import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:in_app_purchase/in_app_purchase.dart';

import '../../core/iap/iap_service.dart';
import '../../core/network/api_client.dart';
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

enum _StoreState { loading, ready, unavailable }

class _WalletScreenState extends ConsumerState<WalletScreen> {
  StreamSubscription<IapEvent>? _events;
  Map<String, ProductDetails> _products = {};
  _StoreState _store = _StoreState.loading;

  IapService get _iap => ref.read(iapProvider);

  @override
  void initState() {
    super.initState();
    // Purchases are processed by the app-wide IapService (so none are lost when this screen
    // closes); the screen only reports what happened to the one the user started here.
    _events = _iap.events.listen(_onEvent);
    unawaited(_loadStore());
  }

  @override
  void dispose() {
    _events?.cancel();
    super.dispose();
  }

  Future<void> _loadStore() async {
    if (_store != _StoreState.loading) {
      setState(() => _store = _StoreState.loading);
    }
    try {
      if (!await _iap.isAvailable()) {
        if (mounted) setState(() => _store = _StoreState.unavailable);
        return;
      }
      final packages = await ref.read(_packagesProvider.future);
      final res = packages.isEmpty
          ? null
          : await _iap.products(packages.map((p) => p.sku).toSet());
      if (!mounted) return;
      setState(() {
        _store = _StoreState.ready;
        _products = {
          for (final p in res?.productDetails ?? const <ProductDetails>[])
            p.id: p,
        };
      });
    } catch (e) {
      if (mounted) setState(() => _store = _StoreState.unavailable);
    }
  }

  void _buy(RechargePackage pkg) {
    final product = _products[pkg.sku];
    if (product == null) {
      return showMessage(
        context,
        'This package is not available in your store',
      );
    }
    unawaited(_iap.buy(product));
  }

  void _onEvent(IapEvent event) {
    if (!mounted) return;
    switch (event) {
      case IapCredited(:final diamonds):
        if (diamonds > 0) {
          showMessage(context, '💎 ${Fmt.full(diamonds)} diamonds added');
        }
      case IapPending():
        showMessage(
          context,
          'Payment pending. Your diamonds arrive as soon as it clears.',
        );
      case IapCancelled():
        break;
      case IapFailed(:final error):
        showError(context, error);
    }
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
                    color: BBColors.goldShadow,
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
                  FittedBox(
                    fit: BoxFit.scaleDown,
                    child: DiamondAmount(
                      me.wallet.diamonds,
                      style: const TextStyle(fontSize: 32, color: BBColors.ink),
                    ),
                  ),
                  const SizedBox(height: 16),
                  Row(
                    children: [
                      const Text(
                        'Beans  ',
                        style: TextStyle(color: BBColors.bronzeDeep),
                      ),
                      Expanded(
                        child: Align(
                          alignment: AlignmentDirectional.centerStart,
                          child: FittedBox(
                            fit: BoxFit.scaleDown,
                            child: DiamondAmount(
                              me.wallet.beans,
                              beans: true,
                              style: const TextStyle(color: BBColors.ink),
                            ),
                          ),
                        ),
                      ),
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
            if (_store == _StoreState.unavailable)
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
                onRetry: () {
                  ref.invalidate(_packagesProvider);
                  unawaited(_loadStore());
                },
              ),
              data: (items) => ValueListenableBuilder<String?>(
                valueListenable: _iap.buying,
                builder: (context, buying, _) => GridView.builder(
                  shrinkWrap: true,
                  physics: const NeverScrollableScrollPhysics(),
                  itemCount: items.length,
                  // Height from the content and the user's text size, not a fixed aspect
                  // ratio, so tiles don't overflow on narrow phones or with large text.
                  gridDelegate: SliverGridDelegateWithFixedCrossAxisCount(
                    crossAxisCount: 3,
                    mainAxisSpacing: 10,
                    crossAxisSpacing: 10,
                    mainAxisExtent:
                        24 + MediaQuery.textScalerOf(context).scale(96),
                  ),
                  itemBuilder: (context, i) => _PackageTile(
                    package: items[i],
                    price: _products[items[i].sku]?.price,
                    buying: buying == items[i].sku,
                    onTap: buying != null || _store != _StoreState.ready
                        ? null
                        : () => _buy(items[i]),
                  ),
                ),
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

class _PackageTile extends StatelessWidget {
  const _PackageTile({
    required this.package,
    required this.price,
    required this.buying,
    required this.onTap,
  });
  final RechargePackage package;
  final String? price;
  final bool buying;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) => Semantics(
    button: true,
    enabled: onTap != null,
    label:
        '${Fmt.full(package.diamonds)} diamonds, ${price ?? Fmt.usd(package.priceUsd)}',
    excludeSemantics: true,
    child: InkWell(
      borderRadius: BorderRadius.circular(16),
      onTap: onTap,
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
            FittedBox(
              fit: BoxFit.scaleDown,
              child: Text(
                Fmt.full(package.diamonds),
                style: const TextStyle(
                  fontWeight: FontWeight.w800,
                  fontSize: 16,
                ),
              ),
            ),
            if (package.bonusDiamonds > 0)
              FittedBox(
                fit: BoxFit.scaleDown,
                child: Text(
                  '+${Fmt.full(package.bonusDiamonds)} bonus',
                  style: const TextStyle(
                    color: BBColors.success,
                    fontSize: 11,
                    fontWeight: FontWeight.w700,
                  ),
                ),
              ),
            const SizedBox(height: 4),
            if (buying)
              const SizedBox(
                width: 16,
                height: 16,
                child: CircularProgressIndicator(strokeWidth: 2),
              )
            else
              FittedBox(
                fit: BoxFit.scaleDown,
                child: Text(
                  price ?? Fmt.usd(package.priceUsd),
                  style: const TextStyle(
                    color: BBColors.bronze,
                    fontWeight: FontWeight.w700,
                  ),
                ),
              ),
          ],
        ),
      ),
    ),
  );
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
              title: Text(
                e.label.isEmpty
                    ? 'Transaction'
                    : e.label[0].toUpperCase() + e.label.substring(1),
              ),
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

  /// One key per withdrawal the user means to make: kept across their retries (a timed-out
  /// request may already be on the server), dropped once it succeeds or the form changes.
  String? _opKey;

  static final _email = RegExp(r'^[^@\s]+@[^@\s]+\.[^@\s]+$');

  static String _defaultProvider(String method) => switch (method) {
    'mobile_wallet' => 'bKash',
    'paypal' => 'PayPal',
    _ => '',
  };

  @override
  void initState() {
    super.initState();
    for (final c in [_beans, _provider, _number, _name]) {
      c.addListener(_formChanged);
    }
  }

  void _formChanged() => _opKey = null;

  @override
  void dispose() {
    for (final c in [_beans, _provider, _number, _name]) {
      c.dispose();
    }
    super.dispose();
  }

  String? _validate(int beans, int available) {
    if (beans <= 0) return 'Enter how many beans to withdraw';
    if (beans > available) {
      return 'You have ${Fmt.full(available)} beans available';
    }
    if (_provider.text.trim().isEmpty) {
      return _method == 'bank' ? 'Enter your bank name' : 'Enter the provider';
    }
    final number = _number.text.trim();
    if (number.isEmpty) return 'Enter your payout details';
    if (_method == 'paypal' && !_email.hasMatch(number)) {
      return 'Enter a valid PayPal email';
    }
    if (_name.text.trim().isEmpty) return 'Enter the account holder name';
    return null;
  }

  Future<void> _submit() async {
    if (_busy) return;
    final beans = int.tryParse(_beans.text.trim()) ?? 0;
    final available = ref.read(meProvider).wallet.beans;
    final problem = _validate(beans, available);
    if (problem != null) return showMessage(context, problem);
    final ok = await showDialog<bool>(
      context: context,
      builder: (c) => AlertDialog(
        title: const Text('Request withdrawal?'),
        content: Text(
          '${Fmt.full(beans)} beans to ${_provider.text.trim()} '
          '${_number.text.trim()} (${_name.text.trim()}). '
          'The beans are held until the request is reviewed.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(c, false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(c, true),
            child: const Text('Request'),
          ),
        ],
      ),
    );
    if (ok != true || !mounted) return;
    setState(() => _busy = true);
    final key = _opKey ??= ApiClient.newIdempotencyKey();
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
            idempotencyKey: key,
          );
      await ref.read(sessionProvider.notifier).refresh();
      if (!mounted) return;
      ref.invalidate(_withdrawalsProvider);
      _beans.clear();
      _opKey = null;
      showMessage(
        context,
        'Request submitted · ${Fmt.usd(res.dbl('amountUsd'))}. We review within 3 business days.',
      );
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
      body: RefreshIndicator(
        onRefresh: () async {
          ref.invalidate(_withdrawalsProvider);
          await ref.read(sessionProvider.notifier).refresh();
        },
        child: ListView(
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
              onChanged: (v) => setState(() {
                final next = v ?? 'mobile_wallet';
                // Don't carry "bKash" into a bank or PayPal request.
                if (_provider.text.trim() == _defaultProvider(_method)) {
                  _provider.text = _defaultProvider(next);
                }
                _method = next;
                _opKey = null;
              }),
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
              keyboardType: _method == 'paypal'
                  ? TextInputType.emailAddress
                  : TextInputType.text,
              decoration: InputDecoration(
                labelText: _method == 'paypal'
                    ? 'PayPal email'
                    : 'Account number',
              ),
            ),
            const SizedBox(height: 12),
            TextField(
              controller: _name,
              decoration: const InputDecoration(
                labelText: 'Account holder name',
              ),
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
              error: (e, _) => ErrorView(
                error: e,
                onRetry: () => ref.invalidate(_withdrawalsProvider),
              ),
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
      ),
    );
  }
}

final _agentSummaryProvider = FutureProvider.autoDispose<AgentSummary>(
  (ref) => ref.read(economyRepo).agentSummary(),
);

/// Agent (reseller) tool: transfer diamonds from stock to a user by BigBoss ID, and the
/// history of those transfers.
class AgentRechargeScreen extends ConsumerStatefulWidget {
  const AgentRechargeScreen({super.key});
  @override
  ConsumerState<AgentRechargeScreen> createState() =>
      _AgentRechargeScreenState();
}

class _AgentRechargeScreenState extends ConsumerState<AgentRechargeScreen> {
  final _history = PagedListController<AgentRecharge>();

  @override
  Widget build(BuildContext context) => DefaultTabController(
    length: 2,
    child: Scaffold(
      appBar: AppBar(
        title: const Text('Agent recharge'),
        bottom: const TabBar(
          tabs: [
            Tab(text: 'Recharge'),
            Tab(text: 'History'),
          ],
        ),
      ),
      body: TabBarView(
        children: [
          _AgentRechargeForm(
            onRecharged: () {
              ref.invalidate(_agentSummaryProvider);
              unawaited(_history.refresh());
            },
          ),
          _AgentHistory(controller: _history),
        ],
      ),
    ),
  );
}

class _AgentRechargeForm extends ConsumerStatefulWidget {
  const _AgentRechargeForm({required this.onRecharged});
  final VoidCallback onRecharged;
  @override
  ConsumerState<_AgentRechargeForm> createState() => _AgentRechargeFormState();
}

class _AgentRechargeFormState extends ConsumerState<_AgentRechargeForm>
    with AutomaticKeepAliveClientMixin {
  static const _quickAmounts = [100, 500, 1000, 5000, 10000];
  final _id = TextEditingController();
  final _amount = TextEditingController();
  UserBrief? _target;
  bool _busy = false;
  bool _looking = false;

  /// Kept for one (recipient, amount) transfer across the agent's retries, so a timed-out
  /// recharge that already went through isn't sent twice.
  ({String intent, String key})? _op;

  @override
  bool get wantKeepAlive => true;

  @override
  void dispose() {
    _id.dispose();
    _amount.dispose();
    super.dispose();
  }

  Future<void> _lookup() async {
    final id = _id.text.trim();
    if (id.isEmpty) return;
    setState(() => _looking = true);
    try {
      final u = await ref.read(economyRepo).agentLookup(id);
      // The agent may have typed another ID meanwhile; never show (and later pay) a stale
      // lookup next to a different number.
      if (mounted && _id.text.trim() == id) setState(() => _target = u);
    } catch (e) {
      if (!mounted || _id.text.trim() != id) return;
      setState(() => _target = null);
      showError(context, e);
    } finally {
      if (mounted) setState(() => _looking = false);
    }
  }

  Future<void> _recharge() async {
    final amount = int.tryParse(_amount.text.trim()) ?? 0;
    final target = _target;
    if (target == null || amount <= 0) return;
    final stock = ref.read(meProvider).wallet.agentStock;
    if (amount > stock) {
      showMessage(context, 'Not enough stock (${Fmt.full(stock)} 💎)');
      return;
    }
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
    if (ok != true || !mounted) return;
    setState(() => _busy = true);
    final intent = '${target.id}:$amount';
    final op = _op?.intent == intent
        ? _op!
        : (intent: intent, key: ApiClient.newIdempotencyKey());
    _op = op;
    try {
      await ref
          .read(economyRepo)
          .agentRecharge(target.id, amount, idempotencyKey: op.key);
      _op = null;
      await ref.read(sessionProvider.notifier).refresh();
      if (!mounted) return;
      _amount.clear();
      widget.onRecharged();
      showMessage(context, 'Recharged ${target.displayName}');
    } catch (e) {
      if (mounted) showError(context, e);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    super.build(context);
    final me = ref.watch(meProvider);
    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        Container(
          padding: const EdgeInsets.all(18),
          decoration: BoxDecoration(
            gradient: BBColors.goldGradient,
            borderRadius: BorderRadius.circular(20),
          ),
          child: Row(
            children: [
              const Icon(Icons.verified, color: BBColors.ivory),
              const SizedBox(width: 8),
              const Expanded(
                child: Text(
                  'Agent stock',
                  style: TextStyle(
                    color: BBColors.ivory,
                    fontWeight: FontWeight.w700,
                  ),
                ),
              ),
              DiamondAmount(
                me.wallet.agentStock,
                style: const TextStyle(color: BBColors.ivory, fontSize: 20),
              ),
            ],
          ),
        ),
        const SizedBox(height: 16),
        TextField(
          controller: _id,
          keyboardType: TextInputType.number,
          inputFormatters: [FilteringTextInputFormatter.digitsOnly],
          decoration: InputDecoration(
            labelText: 'User BigBoss ID',
            suffixIcon: _looking
                ? const Padding(
                    padding: EdgeInsets.all(14),
                    child: SizedBox.square(
                      dimension: 18,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    ),
                  )
                : IconButton(
                    tooltip: 'Look up',
                    onPressed: _lookup,
                    icon: const Icon(Icons.search),
                  ),
          ),
          onChanged: (_) {
            if (_target != null) setState(() => _target = null);
          },
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
          onChanged: (_) => setState(() {}),
        ),
        const SizedBox(height: 10),
        Wrap(
          spacing: 8,
          runSpacing: 8,
          children: [
            for (final a in _quickAmounts)
              ChoiceChip(
                label: Text('💎 ${Fmt.compact(a)}'),
                selected: _amount.text == '$a',
                onSelected: (_) => setState(() => _amount.text = '$a'),
              ),
          ],
        ),
        const SizedBox(height: 20),
        GoldButton(
          label: 'Recharge',
          loading: _busy,
          onPressed: _target == null ? null : _recharge,
        ),
      ],
    );
  }
}

class _AgentHistory extends ConsumerStatefulWidget {
  const _AgentHistory({required this.controller});
  final PagedListController<AgentRecharge> controller;
  @override
  ConsumerState<_AgentHistory> createState() => _AgentHistoryState();
}

class _AgentHistoryState extends ConsumerState<_AgentHistory>
    with AutomaticKeepAliveClientMixin {
  final _search = TextEditingController();
  String? _shortId;

  @override
  bool get wantKeepAlive => true;

  @override
  void dispose() {
    _search.dispose();
    super.dispose();
  }

  void _apply() {
    final q = _search.text.trim();
    setState(() => _shortId = q.isEmpty ? null : q);
  }

  @override
  Widget build(BuildContext context) {
    super.build(context);
    final summaryAsync = ref.watch(_agentSummaryProvider);
    final summary = summaryAsync.value;
    String cell(int? v, {bool diamonds = true}) => summary == null
        ? '—'
        : '${diamonds ? '💎 ' : ''}${Fmt.compact(v ?? 0)}';
    return Column(
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 16, 16, 8),
          child: Row(
            children: [
              // "—" while loading or failed, never a misleading zero.
              _SummaryCell(
                label: 'Transfers',
                value: cell(summary?.count, diamonds: false),
              ),
              _SummaryCell(label: 'Today', value: cell(summary?.todayDiamonds)),
              _SummaryCell(
                label: 'This month',
                value: cell(summary?.monthDiamonds),
              ),
              _SummaryCell(
                label: 'All time',
                value: cell(summary?.totalDiamonds),
              ),
            ],
          ),
        ),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 16),
          child: TextField(
            controller: _search,
            keyboardType: TextInputType.number,
            inputFormatters: [FilteringTextInputFormatter.digitsOnly],
            textInputAction: TextInputAction.search,
            decoration: InputDecoration(
              isDense: true,
              hintText: 'Filter by user ID',
              prefixIcon: const Icon(Icons.search),
              suffixIcon: _shortId == null
                  ? null
                  : IconButton(
                      tooltip: 'Clear filter',
                      icon: const Icon(Icons.close),
                      onPressed: () {
                        _search.clear();
                        _apply();
                      },
                    ),
            ),
            onSubmitted: (_) => _apply(),
          ),
        ),
        Expanded(
          child: PagedList<AgentRecharge>(
            key: ValueKey(_shortId),
            controller: widget.controller,
            separator: true,
            load: (cursor) => ref
                .read(economyRepo)
                .agentHistory(cursor: cursor, shortId: _shortId),
            empty: EmptyState(
              icon: Icons.history,
              title: _shortId == null
                  ? 'No recharges yet'
                  : 'No recharges to ID $_shortId',
            ),
            itemBuilder: (_, r) => ListTile(
              leading: BBAvatar.user(r.user, fallbackName: '?'),
              title: Text(
                r.user?.displayName ?? 'Unknown user',
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(fontWeight: FontWeight.w700),
              ),
              subtitle: Text(
                [
                  if (r.user != null) 'ID ${r.user!.shortId}',
                  if (r.createdAt != null) Fmt.dateTime(r.createdAt!),
                ].join(' · '),
                style: const TextStyle(color: BBColors.inkSubtle),
              ),
              trailing: Text(
                '+💎 ${Fmt.full(r.diamonds)}',
                style: const TextStyle(
                  color: BBColors.success,
                  fontWeight: FontWeight.w800,
                ),
              ),
            ),
          ),
        ),
      ],
    );
  }
}

class _SummaryCell extends StatelessWidget {
  const _SummaryCell({required this.label, required this.value});
  final String label;
  final String value;

  @override
  Widget build(BuildContext context) => Expanded(
    child: Column(
      children: [
        Text(
          value,
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
          style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 14),
        ),
        Text(
          label,
          style: const TextStyle(color: BBColors.inkSubtle, fontSize: 11),
        ),
      ],
    ),
  );
}
