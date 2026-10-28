import 'dart:convert';
import 'dart:typed_data';

import 'package:bigboss_live/core/network/api_client.dart';
import 'package:bigboss_live/core/network/api_exception.dart';
import 'package:dio/dio.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter_test/flutter_test.dart';

class _SignedOut implements FirebaseAuth {
  @override
  User? get currentUser => null;
  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

/// Answers each request with the next scripted response (or error).
class _Adapter implements HttpClientAdapter {
  _Adapter(this.script);
  final List<Object Function(RequestOptions)> script;
  final requests = <RequestOptions>[];

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) async {
    requests.add(options);
    final next = script.removeAt(0)(options);
    if (next is DioException) throw next;
    return next as ResponseBody;
  }

  @override
  void close({bool force = false}) {}
}

ResponseBody _json(Map<String, dynamic> body, [int status = 200]) =>
    ResponseBody.fromString(
      jsonEncode(body),
      status,
      headers: {
        Headers.contentTypeHeader: [Headers.jsonContentType],
      },
    );

DioException Function(RequestOptions) _fail(DioExceptionType type) =>
    (o) => DioException(requestOptions: o, type: type);

(ApiClient, _Adapter) _client(List<Object Function(RequestOptions)> script) {
  final adapter = _Adapter(script);
  final dio = Dio(BaseOptions(baseUrl: 'https://api.test/v1'))
    ..httpClientAdapter = adapter;
  final api = ApiClient(
    deviceId: 'd1',
    auth: _SignedOut(),
    dio: dio,
    retryDelay: Duration.zero,
  );
  return (api, adapter);
}

void main() {
  test(
    'a caller key is sent and reused when a timed-out request is replayed',
    () async {
      final (api, adapter) = _client([
        _fail(DioExceptionType.receiveTimeout),
        (_) => _json({'ok': true}),
      ]);
      final res = await api.post('/withdrawals', idempotencyKey: 'op-123456');
      expect(res['ok'], isTrue);
      expect(adapter.requests, hasLength(2));
      for (final r in adapter.requests) {
        expect(r.headers['Idempotency-Key'], 'op-123456');
      }
    },
  );

  test('a keyed request that never gets an answer says it may have gone '
      'through', () async {
    final (api, _) = _client([
      _fail(DioExceptionType.receiveTimeout),
      _fail(DioExceptionType.receiveTimeout),
    ]);
    await expectLater(
      api.post('/agent/recharge', idempotencyKey: 'op-123456'),
      throwsA(
        isA<ApiException>()
            .having((e) => e.code, 'code', 'timeout')
            .having((e) => e.isNetwork, 'isNetwork', isTrue),
      ),
    );
  });

  test('an unkeyed POST is never replayed', () async {
    final (api, adapter) = _client([_fail(DioExceptionType.receiveTimeout)]);
    await expectLater(
      api.post('/feed', body: {'text': 'hi'}),
      throwsA(isA<ApiException>().having((e) => e.code, 'code', 'network')),
    );
    expect(adapter.requests, hasLength(1));
  });

  test(
    'idempotent: true mints one key per call, shared by its retry',
    () async {
      final (api, adapter) = _client([
        _fail(DioExceptionType.connectionError),
        (_) => _json({}),
        (_) => _json({}),
      ]);
      await api.post('/gifts/send', idempotent: true);
      await api.post('/gifts/send', idempotent: true);
      final keys = [
        for (final r in adapter.requests) r.headers['Idempotency-Key'],
      ];
      expect(keys[0], startsWith('app-'));
      expect(keys[1], keys[0]); // the network retry
      expect(keys[2], isNot(keys[0])); // a new call
    },
  );

  test('server errors map to their code and message', () async {
    final (api, _) = _client([
      (_) => _json({
        'error': {'code': 'insufficient_balance', 'message': 'Not enough'},
      }, 402),
    ]);
    await expectLater(
      api.post('/gifts/send', idempotent: true),
      throwsA(
        isA<ApiException>()
            .having((e) => e.status, 'status', 402)
            .having((e) => e.insufficientBalance, 'insufficient', isTrue),
      ),
    );
  });

  test(
    'null query values are dropped without touching the caller map',
    () async {
      final (api, adapter) = _client([(_) => _json({})]);
      final query = <String, dynamic>{'cursor': null, 'q': 'x'};
      await api.get('/agent/history', query: query);
      expect(adapter.requests.single.queryParameters, {'q': 'x'});
      expect(query, containsPair('cursor', null));
    },
  );
}
