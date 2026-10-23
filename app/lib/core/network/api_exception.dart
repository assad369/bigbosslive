/// Every failed API call surfaces as an [ApiException] with the server's error code.
class ApiException implements Exception {
  const ApiException(this.status, this.code, this.message, [this.details]);

  final int status;
  final String code;
  final String message;
  final Object? details;

  bool get isNetwork => status == 0;
  bool get isUnauthorized => status == 401;
  bool get insufficientBalance => code == 'insufficient_balance';

  @override
  String toString() => message;
}
