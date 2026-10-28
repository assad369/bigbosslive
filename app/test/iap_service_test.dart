import 'dart:async';

import 'package:bigboss_live/core/iap/iap_service.dart';
import 'package:bigboss_live/core/network/api_exception.dart';
import 'package:bigboss_live/core/utils/json.dart';
import 'package:bigboss_live/data/repositories.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:in_app_purchase/in_app_purchase.dart';

class _Gateway implements PurchaseGateway {
  final updates = StreamController<List<PurchaseDetails>>.broadcast();
  final completed = <PurchaseDetails>[];
  List<PurchaseDetails> unfinished = [];
  Object? buyError;

  Future<void> close() => updates.close();

  @override
  Stream<List<PurchaseDetails>> get purchaseStream => updates.stream;
  @override
  Future<bool> isAvailable() async => true;
  @override
  Future<ProductDetailsResponse> queryProductDetails(Set<String> ids) async =>
      ProductDetailsResponse(productDetails: [], notFoundIDs: ids.toList());
  @override
  Future<bool> buyConsumable(ProductDetails product) async {
    if (buyError != null) throw buyError!;
    return true;
  }

  @override
  Future<void> completePurchase(PurchaseDetails purchase) async =>
      completed.add(purchase);
  @override
  Future<List<PurchaseDetails>> unfinishedPurchases() async => unfinished;
}

class _Repo implements EconomyRepository {
  Object? fail;
  final verified = <String>[];

  Future<Json> _verify(String key) async {
    verified.add(key);
    if (fail != null) throw fail!;
    return {'credited': 500, 'diamonds': 900};
  }

  @override
  Future<Json> verifyApple(
    String transactionId, {
    required String idempotencyKey,
  }) => _verify(idempotencyKey);

  @override
  Future<Json> verifyGoogle(
    String productId,
    String token, {
    required String idempotencyKey,
  }) => _verify(idempotencyKey);

  @override
  dynamic noSuchMethod(Invocation invocation) =>
      throw UnimplementedError('${invocation.memberName}');
}

ProductDetails _product(String id) => ProductDetails(
  id: id,
  title: id,
  description: '',
  price: r'$0.99',
  rawPrice: 0.99,
  currencyCode: 'USD',
);

PurchaseDetails _purchase(
  String sku, {
  PurchaseStatus status = PurchaseStatus.purchased,
  String? id = 'txn-1',
}) => PurchaseDetails(
  purchaseID: id,
  productID: sku,
  verificationData: PurchaseVerificationData(
    localVerificationData: '',
    serverVerificationData: 'token-abc',
    source: 'test',
  ),
  transactionDate: null,
  status: status,
)..pendingCompletePurchase = true;

void main() {
  late _Gateway gateway;
  late _Repo repo;
  late int refreshed;
  late List<IapEvent> events;

  IapService service({bool android = false}) {
    final s = IapService(
      gateway: gateway,
      repo: () => repo,
      onCredited: () async => refreshed++,
      isAndroid: android,
    );
    s.events.listen(events.add);
    addTearDown(s.dispose);
    return s;
  }

  Future<void> deliver(PurchaseDetails p) async {
    gateway.updates.add([p]);
    await pumpEventQueue();
  }

  setUp(() {
    gateway = _Gateway();
    addTearDown(gateway.close);
    repo = _Repo();
    refreshed = 0;
    events = [];
  });

  test('a verified purchase is completed, credited and reported', () async {
    final iap = service();
    await iap.start();
    await iap.buy(_product('gems_100'));
    expect(iap.buying.value, 'gems_100');

    await deliver(_purchase('gems_100'));
    expect(gateway.completed, hasLength(1));
    expect(refreshed, 1);
    expect(iap.buying.value, isNull);
    expect(events.single, isA<IapCredited>());
    expect((events.single as IapCredited).diamonds, 500);
    expect(repo.verified.single, 'iap-txn-1');
  });

  test('iOS: a purchase the server could not verify is NOT finished', () async {
    // Finishing it would let StoreKit forget a purchase that was never credited.
    repo.fail = const ApiException(0, 'network', 'offline');
    final iap = service();
    await iap.start();
    await iap.buy(_product('gems_100'));
    await deliver(_purchase('gems_100'));

    expect(gateway.completed, isEmpty);
    expect(refreshed, 0);
    expect(iap.buying.value, isNull);
    expect(events.single, isA<IapFailed>());
  });

  test('iOS: an upstream "could not verify" 402 is retryable too', () async {
    repo.fail = const ApiException(
      402,
      'purchase_invalid',
      'The App Store could not verify this purchase',
    );
    final iap = service();
    await iap.start();
    await deliver(_purchase('gems_100'));
    expect(gateway.completed, isEmpty);
  });

  test('iOS: a definitive rejection is finished', () async {
    repo.fail = const ApiException(409, 'conflict', 'already redeemed');
    final iap = service();
    await iap.start();
    await deliver(_purchase('gems_100'));
    expect(gateway.completed, hasLength(1));
  });

  test(
    'Android: always acknowledged; unconsumed purchases are retried on start',
    () async {
      repo.fail = const ApiException(503, 'error', 'down');
      final iap = service(android: true);
      await iap.start();
      await deliver(_purchase('gems_100'));
      expect(gateway.completed, hasLength(1));

      // Next launch: Play still holds it (never consumed), and the server is back.
      repo.fail = null;
      gateway.unfinished = [_purchase('gems_100')];
      final next = service(android: true);
      await next.start();
      expect(repo.verified, hasLength(2));
      expect(refreshed, 1);
    },
  );

  test('purchases delivered before sign-in wait for it', () async {
    final iap = service()..attach();
    await deliver(_purchase('gems_100'));
    expect(repo.verified, isEmpty);

    await iap.start();
    expect(repo.verified, hasLength(1));
    expect(gateway.completed, hasLength(1));
  });

  test('a pending payment releases the buy button', () async {
    final iap = service();
    await iap.start();
    await iap.buy(_product('gems_100'));
    await deliver(_purchase('gems_100', status: PurchaseStatus.pending));
    expect(iap.buying.value, isNull);
    expect(events.single, isA<IapPending>());
    expect(gateway.completed, isEmpty);
  });

  test('a store error starting the purchase is reported, not stuck', () async {
    gateway.buyError = StateError('storekit_duplicate_product_object');
    final iap = service();
    await iap.start();
    await iap.buy(_product('gems_100'));
    await pumpEventQueue();
    expect(iap.buying.value, isNull);
    expect(events.single, isA<IapFailed>());
  });

  test('only one purchase at a time', () async {
    final iap = service();
    await iap.start();
    await iap.buy(_product('gems_100'));
    await iap.buy(_product('gems_500'));
    expect(iap.buying.value, 'gems_100');
  });

  test('idempotency keys fit the server pattern', () {
    final key = IapService.idempotencyKeyFor(
      _purchase('x', id: 'GPA.1234-5678 /9+'),
    );
    expect(key, 'iap-GPA.1234-5678__9_');
    expect(RegExp(r'^[A-Za-z0-9_\-:.]{8,128}$').hasMatch(key), isTrue);

    final fromToken = IapService.idempotencyKeyFor(_purchase('x', id: null));
    expect(fromToken, startsWith('iap-tok'));
    expect(
      IapService.idempotencyKeyFor(_purchase('x', id: null)),
      fromToken,
      reason: 'stable for the same token',
    );
  });
}
