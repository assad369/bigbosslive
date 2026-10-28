import 'package:intl/intl.dart';
import 'package:timeago/timeago.dart' as timeago;

abstract final class Fmt {
  static final _compact = NumberFormat.compact();
  static final _full = NumberFormat.decimalPattern();
  static final _dateTime = DateFormat('d MMM y, HH:mm');
  static final _date = DateFormat('d MMM y');
  static final _monthYear = DateFormat('MMMM y');

  static String compact(num n) => _compact.format(n);
  static String full(num n) => _full.format(n);
  static String ago(DateTime? d) => d == null ? '' : timeago.format(d);

  /// Relative time that also reads the future correctly ("a month from now"); [ago] turns
  /// every future date into "a moment ago".
  static String relative(DateTime? d, {DateTime? clock}) =>
      d == null ? '' : timeago.format(d, clock: clock, allowFromNow: true);
  static String dateTime(DateTime d) => _dateTime.format(d.toLocal());
  static String date(DateTime d) => _date.format(d.toLocal());

  /// "October 2026" for a "YYYY-MM" period key; the key itself if it doesn't parse.
  static String monthKey(String key) {
    final d = DateTime.tryParse('$key-01');
    return d == null ? key : _monthYear.format(d);
  }

  static String usd(num n) =>
      NumberFormat.simpleCurrency(name: 'USD').format(n);

  /// `mm:ss`, or `h:mm:ss` from an hour.
  static String clock(int seconds) {
    final s = seconds < 0 ? 0 : seconds;
    String two(int n) => n.toString().padLeft(2, '0');
    final h = s ~/ 3600;
    final body = '${two((s % 3600) ~/ 60)}:${two(s % 60)}';
    return h > 0 ? '$h:$body' : body;
  }

  static String duration(int seconds) {
    final h = seconds ~/ 3600;
    final m = (seconds % 3600) ~/ 60;
    final s = seconds % 60;
    if (h > 0) return '${h}h ${m}m';
    if (m > 0) return '${m}m ${s}s';
    return '${s}s';
  }
}
