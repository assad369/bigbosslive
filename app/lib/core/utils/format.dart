import 'package:intl/intl.dart';
import 'package:timeago/timeago.dart' as timeago;

abstract final class Fmt {
  static final _compact = NumberFormat.compact();
  static final _full = NumberFormat.decimalPattern();

  static String compact(num n) => _compact.format(n);
  static String full(num n) => _full.format(n);
  static String ago(DateTime? d) => d == null ? '' : timeago.format(d);
  static String usd(num n) =>
      NumberFormat.simpleCurrency(name: 'USD').format(n);

  static String duration(int seconds) {
    final h = seconds ~/ 3600;
    final m = (seconds % 3600) ~/ 60;
    final s = seconds % 60;
    if (h > 0) return '${h}h ${m}m';
    if (m > 0) return '${m}m ${s}s';
    return '${s}s';
  }
}
