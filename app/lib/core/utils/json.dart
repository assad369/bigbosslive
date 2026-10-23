/// Small, strict-cast-safe JSON readers used by every model's `fromJson`.
typedef Json = Map<String, dynamic>;

extension JsonRead on Json {
  String str(String k, [String fallback = '']) =>
      (this[k] as String?) ?? fallback;
  String? strOrNull(String k) => this[k] as String?;
  int integer(String k, [int fallback = 0]) =>
      (this[k] as num?)?.toInt() ?? fallback;
  double dbl(String k, [double fallback = 0]) =>
      (this[k] as num?)?.toDouble() ?? fallback;
  bool flag(String k, [bool fallback = false]) =>
      (this[k] as bool?) ?? fallback;
  DateTime? date(String k) {
    final v = this[k];
    return v is String ? DateTime.tryParse(v)?.toLocal() : null;
  }

  Json obj(String k) => (this[k] as Map<String, dynamic>?) ?? const {};
  Json? objOrNull(String k) => this[k] as Map<String, dynamic>?;
  List<T> list<T>(String k, T Function(Json) parse) =>
      ((this[k] as List<dynamic>?) ?? const [])
          .whereType<Map<String, dynamic>>()
          .map(parse)
          .toList();
  List<String> strings(String k) =>
      ((this[k] as List<dynamic>?) ?? const []).whereType<String>().toList();
  Map<String, num> numMap(String k) =>
      ((this[k] as Map<String, dynamic>?) ?? const {}).map(
        (key, v) => MapEntry(key, (v as num?) ?? 0),
      );
}

class Paged<T> {
  const Paged({required this.items, this.nextCursor, this.total});
  final List<T> items;
  final String? nextCursor;
  final int? total;

  static Paged<T> fromJson<T>(Json j, T Function(Json) parse) => Paged(
    items: j.list('items', parse),
    nextCursor: j.strOrNull('nextCursor'),
    total: (j['total'] as num?)?.toInt(),
  );
}
