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
  ApiClient({required this.deviceId, FirebaseAuth? auth, Dio? dio})
    : _auth = auth ?? FirebaseAuth.instance,
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
          final token = await _auth.currentUser?.getIdToken();
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
            try {
              final fresh = await _auth.currentUser!.getIdToken(true);
              opts.headers['Authorization'] = 'Bearer $fresh';
              opts.extra['bb_retried'] = true;
              return handler.resolve(await this.dio.fetch<dynamic>(opts));
            } catch (_) {
              /* fall through */
            }
          }
          // Transient network failure on a safe (or idempotency-keyed) request: retry once.
          final safe =
              opts.method == 'GET' ||
              opts.headers.containsKey('Idempotency-Key');
          final transient =
              err.type == DioExceptionType.connectionError ||
              err.type == DioExceptionType.connectionTimeout;
          if (safe && transient && !retried) {
            await Future<void>.delayed(const Duration(milliseconds: 600));
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

  static String newIdempotencyKey() => 'app-${const Uuid().v4()}';

  ApiException _map(Object e) {
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
  }) async {
    try {
      final res = await dio.request<dynamic>(
        path,
        data: body,
        queryParameters: query?..removeWhere((_, v) => v == null),
        options: Options(
          method: method,
          headers: idempotent ? {'Idempotency-Key': newIdempotencyKey()} : null,
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
  Future<Map<String, dynamic>> post(
    String path, {
    Object? body,
    bool idempotent = false,
  }) => _send('POST', path, body: body, idempotent: idempotent);
  Future<Map<String, dynamic>> patch(String path, {Object? body}) =>
      _send('PATCH', path, body: body);
  Future<Map<String, dynamic>> delete(String path, {Object? body}) =>
      _send('DELETE', path, body: body);

  /// Upload a file straight to object storage with a presigned URL; returns its public URL.
  Future<String> upload({
    required String kind,
    required File file,
    required String contentType,
  }) async {
    final presign = await post(
      '/uploads/presign',
      body: {'kind': kind, 'contentType': contentType},
    );
    try {
      await Dio().put<void>(
        presign['uploadUrl'] as String,
        data: file.openRead(),
        options: Options(
          headers: {
            'Content-Type': contentType,
            Headers.contentLengthHeader: await file.length(),
          },
        ),
      );
    } catch (e) {
      throw _map(e);
    }
    return presign['publicUrl'] as String;
  }
}
