import 'dart:io';

import 'package:dio/dio.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter/foundation.dart';
import 'package:uuid/uuid.dart';

import '../config/env.dart';
import 'api_exception.dart';

/// HTTP client for the BigBoss Live API.
///
/// Attaches the Firebase ID token, device id and platform to every request, retries once with
/// a force-refreshed token on 401, retries idempotent requests on transient network errors,
/// and maps every failure to an [ApiException].
class ApiClient {
  ApiClient({
    required this.deviceId,
    FirebaseAuth? auth,
    Dio? dio,
    this.retryDelay = const Duration(milliseconds: 600),
  }) : _auth = auth ?? FirebaseAuth.instance,
       dio =
           dio ??
           Dio(
             BaseOptions(
               baseUrl: '${Env.apiUrl}/v1',
               connectTimeout: const Duration(seconds: 10),
               receiveTimeout: const Duration(seconds: 20),
             ),
           ) {
    this.dio.interceptors.add(
      InterceptorsWrapper(
        onRequest: (options, handler) async {
          final String? token;
          try {
            token = await _auth.currentUser?.getIdToken();
          } catch (e) {
            // Not a connectivity problem: say so instead of "No connection".
            return handler.reject(
              DioException(
                requestOptions: options,
                error: const ApiException(
                  401,
                  'session_expired',
                  'Your session expired. Please sign in again.',
                ),
              ),
            );
          }
          if (token != null) options.headers['Authorization'] = 'Bearer $token';
          options.headers['X-Device-Id'] = deviceId;
          options.headers['X-Platform'] = Platform.isIOS ? 'ios' : 'android';
          handler.next(options);
        },
        onError: (err, handler) async {
          final opts = err.requestOptions;
          final retried = opts.extra['bb_retried'] == true;
          // Expired token: refresh once and replay.
          if (err.response?.statusCode == 401 &&
              !retried &&
              _auth.currentUser != null) {
            final String? fresh;
            try {
              fresh = await _auth.currentUser!.getIdToken(true);
            } catch (_) {
              return handler.next(err);
            }
            opts.headers['Authorization'] = 'Bearer $fresh';
            opts.extra['bb_retried'] = true;
            try {
              return handler.resolve(await this.dio.fetch<dynamic>(opts));
            } on DioException catch (e) {
              // Report what the replay said (e.g. a ban), not the stale 401.
              return handler.next(e);
            }
          }
          // Transient failure on a safe request: retry once. A keyed request is safe even
          // when the response was lost after the server committed (a receive timeout), since
          // the server dedupes on the key; an unkeyed POST is never replayed.
          final keyed = opts.headers.containsKey('Idempotency-Key');
          final safe = opts.method == 'GET' || keyed;
          final transient =
              err.type == DioExceptionType.connectionError ||
              err.type == DioExceptionType.connectionTimeout ||
              (keyed &&
                  (err.type == DioExceptionType.receiveTimeout ||
                      err.type == DioExceptionType.sendTimeout));
          if (safe && transient && !retried) {
            await Future<void>.delayed(retryDelay);
            opts.extra['bb_retried'] = true;
            try {
              return handler.resolve(await this.dio.fetch<dynamic>(opts));
            } on DioException catch (e) {
              return handler.next(e);
            }
          }
          handler.next(err);
        },
      ),
    );
    if (kDebugMode) {
      this.dio.interceptors.add(
        LogInterceptor(
          // Headers carry the Bearer token.
          requestHeader: false,
          requestBody: false,
          responseBody: false,
          logPrint: (o) => debugPrint(o.toString()),
        ),
      );
    }
  }

  final Dio dio;
  final FirebaseAuth _auth;
  final String deviceId;
  final Duration retryDelay;

  /// A fresh key for one money-moving *intent*. Callers keep it until that intent succeeds
  /// and pass it again on a manual retry, so the server applies the operation once.
  static String newIdempotencyKey() => 'app-${const Uuid().v4()}';

  ApiException _map(Object e) {
    if (e is DioException && e.error is ApiException) {
      return e.error! as ApiException;
    }
    if (e is DioException) {
      final data = e.response?.data;
      if (data is Map<String, dynamic> &&
          data['error'] is Map<String, dynamic>) {
        final err = data['error'] as Map<String, dynamic>;
        return ApiException(
          e.response?.statusCode ?? 500,
          (err['code'] as String?) ?? 'error',
          (err['message'] as String?) ?? 'Request failed',
          err['details'],
        );
      }
      if (e.response == null) {
        final keyed = e.requestOptions.headers.containsKey('Idempotency-Key');
        final timedOut =
            e.type == DioExceptionType.receiveTimeout ||
            e.type == DioExceptionType.sendTimeout;
        if (keyed && timedOut) {
          // The request reached the server; only the answer was lost.
          return const ApiException(
            0,
            'timeout',
            'This is taking longer than usual and may have gone through. '
                'Check your history before trying again.',
          );
        }
        return const ApiException(
          0,
          'network',
          'No connection. Check your internet and try again.',
        );
      }
      return ApiException(
        e.response!.statusCode ?? 500,
        'error',
        'Something went wrong (${e.response!.statusCode})',
      );
    }
    return ApiException(500, 'error', e.toString());
  }

  Future<Map<String, dynamic>> _send(
    String method,
    String path, {
    Object? body,
    Map<String, dynamic>? query,
    bool idempotent = false,
    String? idempotencyKey,
  }) async {
    final key = idempotencyKey ?? (idempotent ? newIdempotencyKey() : null);
    try {
      final res = await dio.request<dynamic>(
        path,
        data: body,
        queryParameters: query == null
            ? null
            : {
                for (final e in query.entries)
                  if (e.value != null) e.key: e.value,
              },
        options: Options(
          method: method,
          headers: key == null ? null : {'Idempotency-Key': key},
        ),
      );
      final data = res.data;
      return data is Map<String, dynamic> ? data : const {};
    } catch (e) {
      throw _map(e);
    }
  }

  Future<Map<String, dynamic>> get(
    String path, {
    Map<String, dynamic>? query,
  }) => _send('GET', path, query: query);

  /// [idempotent] mints a key for this call (network retries reuse it). Pass
  /// [idempotencyKey] instead to keep one key across the user's own retries.
  Future<Map<String, dynamic>> post(
    String path, {
    Object? body,
    bool idempotent = false,
    String? idempotencyKey,
  }) => _send(
    'POST',
    path,
    body: body,
    idempotent: idempotent,
    idempotencyKey: idempotencyKey,
  );
  Future<Map<String, dynamic>> patch(String path, {Object? body}) =>
      _send('PATCH', path, body: body);
  Future<Map<String, dynamic>> put(String path, {Object? body}) =>
      _send('PUT', path, body: body);
  Future<Map<String, dynamic>> delete(String path, {Object? body}) =>
      _send('DELETE', path, body: body);

  /// Upload a file straight to object storage with a presigned URL; returns its public URL.
  /// The size is signed into the URL, so the server can cap it per kind.
  Future<String> upload({
    required String kind,
    required File file,
    required String contentType,
  }) async {
    final size = await file.length();
    final presign = await post(
      '/uploads/presign',
      body: {'kind': kind, 'contentType': contentType, 'size': size},
    );
    final uploadUrl = presign['uploadUrl'];
    final publicUrl = presign['publicUrl'];
    if (uploadUrl is! String || publicUrl is! String) {
      throw const ApiException(500, 'upload', 'Upload is unavailable');
    }
    final signed = (presign['headers'] as Map?)?.cast<String, Object?>() ?? {};
    try {
      await _uploader.put<void>(
        uploadUrl,
        data: file.openRead(),
        options: Options(
          headers: {
            ...signed,
            'Content-Type': contentType,
            Headers.contentLengthHeader: size,
          },
        ),
      );
    } catch (e) {
      throw _map(e);
    }
    return publicUrl;
  }

  /// Plain client for presigned storage URLs: no auth headers, but bounded, so a stalled
  /// upload fails instead of spinning forever.
  late final _uploader = Dio(
    BaseOptions(
      connectTimeout: const Duration(seconds: 15),
      sendTimeout: const Duration(minutes: 2),
      receiveTimeout: const Duration(seconds: 30),
    ),
  );
}
