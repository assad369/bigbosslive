import 'package:flutter/foundation.dart' show debugPrint;

/// Small JSON readers used by every model's `fromJson`.
///
/// They never throw on a wrong type: a missing or mistyped field reads as its fallback, and
/// a list item that can't be parsed is skipped (and logged) rather than failing the whole
/// response. Numbers sent as strings (and the reverse, for ids) are accepted.
typedef Json = Map<String, dynamic>;

extension JsonRead on Json {
  String str(String k, [String fallback = '']) => strOrNull(k) ?? fallback;
  String? strOrNull(String k) => switch (this[k]) {
    final String v => v,
    final num v => v.toString(),
    _ => null,
  };
  int integer(String k, [int fallback = 0]) => switch (this[k]) {
    final num v => v.toInt(),
    final String v => num.tryParse(v)?.toInt() ?? fallback,
    _ => fallback,
  };
  double dbl(String k, [double fallback = 0]) => switch (this[k]) {
    final num v => v.toDouble(),
    final String v => double.tryParse(v) ?? fallback,
    _ => fallback,
  };
  bool flag(String k, [bool fallback = false]) => switch (this[k]) {
    final bool v => v,
    final num v => v != 0,
    'true' => true,
    'false' => false,
    _ => fallback,
  };
  DateTime? date(String k) {
    final v = this[k];
    return v is String ? DateTime.tryParse(v)?.toLocal() : null;
  }

  Json obj(String k) => objOrNull(k) ?? const {};
  Json? objOrNull(String k) => switch (this[k]) {
    final Map<String, dynamic> v => v,
    final Map<dynamic, dynamic> v => v.map((k, v) => MapEntry('$k', v)),
    _ => null,
  };
  List<T> list<T>(String k, T Function(Json) parse) {
    final v = this[k];
    if (v is! List<dynamic>) return const [];
    final out = <T>[];
    for (final item in v.whereType<Map<String, dynamic>>()) {
      try {
        out.add(parse(item));
      } catch (e) {
        debugPrint('json: skipped a malformed "$k" item: $e');
      }
    }
    return out;
  }

  List<String> strings(String k) {
    final v = this[k];
    return v is List<dynamic> ? v.whereType<String>().toList() : const [];
  }

  Map<String, num> numMap(String k) => obj(k)
      .map((key, v) => MapEntry(key, v is num ? v : num.tryParse('$v') ?? 0));
}

class Paged<T> {
  const Paged({required this.items, this.nextCursor, this.total});
  final List<T> items;
  final String? nextCursor;
  final int? total;

  static Paged<T> fromJson<T>(Json j, T Function(Json) parse) => Paged(
    items: j.list('items', parse),
    nextCursor: j.strOrNull('nextCursor'),
    total: j['total'] == null ? null : j.integer('total'),
  );
}
