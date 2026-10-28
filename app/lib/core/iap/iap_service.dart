import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:in_app_purchase/in_app_purchase.dart';
import 'package:in_app_purchase_android/in_app_purchase_android.dart';

import '../../data/repositories.dart';
import '../network/api_exception.dart';

/// The store, behind an interface so the purchase flow can be tested without a device.
abstract interface class PurchaseGateway {
  Stream<List<PurchaseDetails>> get purchaseStream;
  Future<bool> isAvailable();
  Future<ProductDetailsResponse> queryProductDetails(Set<String> ids);
  Future<bool> buyConsumable(ProductDetails product);
  Future<void> completePurchase(PurchaseDetails purchase);

  /// Purchases the store still holds (Android: bought but never consumed). Empty elsewhere.
  Future<List<PurchaseDetails>> unfinishedPurchases();
}

class StorePurchaseGateway implements PurchaseGateway {
  StorePurchaseGateway({required this.isAndroid});
  final bool isAndroid;
  InAppPurchase get _iap => InAppPurchase.instance;

  @override
  Stream<List<PurchaseDetails>> get purchaseStream => _iap.purchaseStream;
  @override
  Future<bool> isAvailable() => _iap.isAvailable();
  @override
  Future<ProductDetailsResponse> queryProductDetails(Set<String> ids) =>
      _iap.queryProductDetails(ids);
  @override
  Future<bool> buyConsumable(ProductDetails product) => _iap.buyConsumable(
    purchaseParam: PurchaseParam(productDetails: product),
    // The server verifies and consumes the purchase; never consume on the client first.
    autoConsume: !isAndroid,
  );
  @override
  Future<void> completePurchase(PurchaseDetails purchase) =>
      _iap.completePurchase(purchase);
  @override
  Future<List<PurchaseDetails>> unfinishedPurchases() async {
    if (!isAndroid) return const [];
    final res = await _iap
        .getPlatformAddition<InAppPurchaseAndroidPlatformAddition>()
        .queryPastPurchases();
    return res.pastPurchases;
  }
}

/// What happened to the purchase the user started from this device.
sealed class IapEvent {
  const IapEvent();
}

class IapCredited extends IapEvent {
  const IapCredited(this.diamonds);
  final int diamonds;
}

class IapPending extends IapEvent {
  const IapPending();
}

class IapCancelled extends IapEvent {
  const IapCancelled();
}

class IapFailed extends IapEvent {
  const IapFailed(this.error);
  final Object error;
}

/// The whole in-app purchase flow, for the app's lifetime.
///
/// The store redelivers every purchase that was never completed: on iOS through
/// [PurchaseGateway.purchaseStream] as soon as it is listened to, on Android through
/// [PurchaseGateway.unfinishedPurchases]. So the stream is listened to from launch, not only
/// while the wallet is open, and nothing is completed until the server has credited it:
///
/// - Verified (or already redeemed by another account): complete.
/// - iOS, server unreachable or unsure: leave it. Completing finishes the transaction for
///   good, so the user would have paid for nothing; StoreKit offers it again next launch.
/// - Android: always acknowledge. That only stops Play's 3-day auto-refund; the credit gate
///   is consumption, which the server does after verifying, and an unconsumed purchase is
///   offered again by [PurchaseGateway.unfinishedPurchases] on the next start.
class IapService {
  IapService({
    required this._gateway,
    required this._repo,
    required this._onCredited,
    required this.isAndroid,
  });

  final PurchaseGateway _gateway;
  final EconomyRepository Function() _repo;
  final Future<void> Function() _onCredited;
  final bool isAndroid;

  /// The SKU the user is buying right now, or null.
  final buying = ValueNotifier<String?>(null);
  final _events = StreamController<IapEvent>.broadcast();
  Stream<IapEvent> get events => _events.stream;

  StreamSubscription<List<PurchaseDetails>>? _sub;
  bool _signedIn = false;
  final _waiting = <PurchaseDetails>[];
  final _verifying = <String>{};

  /// Listen to the store from launch. Updates that arrive signed out wait for [start].
  void attach() {
    _sub ??= _gateway.purchaseStream.listen(
      _onUpdates,
      onError: (Object e) => _finish(IapFailed(e)),
    );
  }

  /// Signed in: verify anything the store is holding.
  Future<void> start() async {
    attach();
    _signedIn = true;
    final waiting = List.of(_waiting);
    _waiting.clear();
    for (final p in waiting) {
      await _process(p);
    }
    try {
      for (final p in await _gateway.unfinishedPurchases()) {
        if (!_signedIn) return;
        await _verify(p);
      }
    } catch (e) {
      debugPrint('iap: could not query unfinished purchases: $e');
    }
  }

  void stop() {
    _signedIn = false;
    buying.value = null;
  }

  Future<bool> isAvailable() => _gateway.isAvailable();

  Future<ProductDetailsResponse> products(Set<String> skus) =>
      _gateway.queryProductDetails(skus);

  Future<void> buy(ProductDetails product) async {
    if (buying.value != null) return;
    buying.value = product.id;
    try {
      final started = await _gateway.buyConsumable(product);
      if (!started) _finish(const IapCancelled());
    } catch (e) {
      // e.g. StoreKit refusing while an earlier transaction for this product is unfinished.
      _finish(IapFailed(e));
    }
  }

  void _onUpdates(List<PurchaseDetails> updates) {
    if (!_signedIn) {
      _waiting.addAll(updates);
      return;
    }
    unawaited(() async {
      for (final p in updates) {
        await _process(p);
      }
    }());
  }

  Future<void> _process(PurchaseDetails p) async {
    switch (p.status) {
      case PurchaseStatus.pending:
        // Slow payment methods (cash, family approval): the store will deliver it later.
        if (p.productID == buying.value) _finish(const IapPending());
      case PurchaseStatus.canceled:
        if (p.productID == buying.value) _finish(const IapCancelled());
        await _complete(p);
      case PurchaseStatus.error:
        if (p.productID == buying.value) {
          _finish(IapFailed(p.error?.message ?? 'Purchase failed'));
        }
        await _complete(p);
      case PurchaseStatus.purchased || PurchaseStatus.restored:
        await _verify(p);
    }
  }

  Future<void> _verify(PurchaseDetails p) async {
    final mine = p.productID == buying.value;
    final transactionId = p.purchaseID;
    if (!isAndroid && (transactionId == null || transactionId.isEmpty)) {
      // Nothing to verify with. Leave it for StoreKit to offer again.
      if (mine) _finish(const IapFailed(_unconfirmed));
      return;
    }
    final key = idempotencyKeyFor(p);
    if (!_verifying.add(key)) return;
    try {
      final repo = _repo();
      final res = isAndroid
          ? await repo.verifyGoogle(
              p.productID,
              p.verificationData.serverVerificationData,
              idempotencyKey: key,
            )
          : await repo.verifyApple(transactionId!, idempotencyKey: key);
      await _complete(p);
      await _onCredited();
      final credited = res['credited'];
      if (mine) _finish(IapCredited(credited is num ? credited.toInt() : 0));
    } catch (e) {
      final definitive = e is ApiException && isDefinitiveRejection(e);
      if (isAndroid || definitive) await _complete(p);
      if (mine) {
        _finish(
          IapFailed(
            definitive ? e : const ApiException(0, 'iap', _unconfirmed),
          ),
        );
      }
    } finally {
      _verifying.remove(key);
    }
  }

  Future<void> _complete(PurchaseDetails p) async {
    if (!p.pendingCompletePurchase) return;
    try {
      await _gateway.completePurchase(p);
    } catch (e) {
      debugPrint('iap: completePurchase failed: $e');
    }
  }

  void _finish(IapEvent event) {
    buying.value = null;
    if (!_events.isClosed) _events.add(event);
  }

  void dispose() {
    unawaited(_sub?.cancel());
    buying.dispose();
    unawaited(_events.close());
  }

  static const _unconfirmed =
      'Payment received, but we could not confirm it yet. Your diamonds will be added '
      'automatically, so there is no need to buy again.';

  /// A server answer that will not change on retry, so the store may forget the purchase.
  ///
  /// The backend reports upstream outages ("could not verify", a malformed store response)
  /// with the same 402 as a bad receipt, so those are treated as retryable.
  @visibleForTesting
  static bool isDefinitiveRejection(ApiException e) {
    if (e.status == 409) return true; // redeemed by another account
    if (e.status != 402 || e.code != 'purchase_invalid') return false;
    final m = e.message.toLowerCase();
    return !m.contains('could not verify') && !m.contains('malformed');
  }

  /// One key per store purchase, so redeliveries and retries are the same request. The
  /// server requires 8–128 characters from `[A-Za-z0-9_\-:.]`.
  @visibleForTesting
  static String idempotencyKeyFor(PurchaseDetails p) {
    final id = p.purchaseID;
    final raw = id != null && id.isNotEmpty
        ? id
        : _fnv1a(p.verificationData.serverVerificationData);
    final safe = raw.replaceAll(RegExp(r'[^A-Za-z0-9_\-:.]'), '_');
    final key = 'iap-$safe';
    return key.length > 128 ? key.substring(0, 128) : key;
  }

  static String _fnv1a(String s) {
    var h = 0x811c9dc5;
    for (final c in s.codeUnits) {
      h = ((h ^ c) * 0x01000193) & 0xffffffff;
    }
    return 'tok${h.toRadixString(16).padLeft(8, '0')}';
  }
}
