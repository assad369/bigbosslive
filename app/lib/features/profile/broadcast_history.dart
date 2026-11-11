import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:intl/intl.dart';

import '../../core/providers.dart';
import '../../core/theme/bb_colors.dart';
import '../../core/utils/format.dart';
import '../../core/widgets/widgets.dart';
import '../../models/models.dart';

/// One month of the signed-in host's lives, keyed by the first of the month (local).
final monthlyHistoryProvider = FutureProvider.autoDispose
    .family<LiveHistoryMonth, DateTime>((ref, month) {
      final uid = ref.watch(meProvider).id;
      return ref.watch(liveRepo).monthlyHistory(uid, month);
    });

DateTime _monthOf(DateTime d) => DateTime(d.year, d.month);

final _monthLabel = DateFormat('MMMM y');
final _dayHeader = DateFormat('EEEE, d MMMM');
final _weekday = DateFormat('EEE');
final _shortMonth = DateFormat('MMM');
final _clock = DateFormat('HH:mm');

/// "Broadcasting History": the host's past lives a month at a time, one tile per day. A day
/// opens its lives; a live opens its [LiveSummaryScreen].
class BroadcastHistoryScreen extends ConsumerStatefulWidget {
  const BroadcastHistoryScreen({super.key});

  @override
  ConsumerState<BroadcastHistoryScreen> createState() =>
      _BroadcastHistoryScreenState();
}

class _BroadcastHistoryScreenState
    extends ConsumerState<BroadcastHistoryScreen> {
  final _current = _monthOf(DateTime.now());
  late DateTime _month = _current;

  /// The month of the first live, from the latest answer (null until known, or never live).
  DateTime? _earliest;

  bool get _canGoBack => _earliest != null && _month.isAfter(_earliest!);
  bool get _canGoForward => _month.isBefore(_current);

  void _shift(int months) =>
      setState(() => _month = DateTime(_month.year, _month.month + months));

  Future<void> _pickMonth() async {
    final picked = await showModalBottomSheet<DateTime>(
      context: context,
      showDragHandle: true,
      builder: (_) => _MonthPicker(
        selected: _month,
        first: _earliest ?? _current,
        last: _current,
      ),
    );
    if (picked != null && mounted) setState(() => _month = picked);
  }

  @override
  Widget build(BuildContext context) {
    final provider = monthlyHistoryProvider(_month);
    final history = ref.watch(provider);
    if (history.value?.earliestMonth case final earliest?) _earliest = earliest;
    return Scaffold(
      appBar: AppBar(title: const Text('Broadcasting History')),
      body: Column(
        children: [
          Material(
            color: BBColors.surface,
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 2),
              child: Row(
                children: [
                  IconButton(
                    tooltip: 'Previous month',
                    onPressed: _canGoBack ? () => _shift(-1) : null,
                    icon: const Icon(Icons.chevron_left_rounded),
                  ),
                  Expanded(
                    child: TextButton.icon(
                      onPressed: _pickMonth,
                      iconAlignment: IconAlignment.end,
                      icon: const Icon(
                        Icons.arrow_drop_down_rounded,
                        color: BBColors.ink,
                      ),
                      label: Text(
                        _monthLabel.format(_month),
                        style: const TextStyle(
                          color: BBColors.ink,
                          fontSize: 16,
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                    ),
                  ),
                  IconButton(
                    tooltip: 'Next month',
                    onPressed: _canGoForward ? () => _shift(1) : null,
                    icon: const Icon(Icons.chevron_right_rounded),
                  ),
                ],
              ),
            ),
          ),
          const Divider(height: 1, color: BBColors.border),
          Expanded(
            child: RefreshIndicator(
              onRefresh: () => ref.refresh(provider.future),
              child: switch (history) {
                AsyncValue(:final value?) => _MonthBody(
                  month: _month,
                  history: value,
                ),
                AsyncValue(:final error?) => _scrollable(
                  ErrorView(
                    error: error,
                    onRetry: () => ref.invalidate(provider),
                  ),
                ),
                _ => const Center(child: CircularProgressIndicator()),
              },
            ),
          ),
        ],
      ),
    );
  }
}

/// Keeps pull-to-refresh working on states that aren't lists.
Widget _scrollable(Widget child) => LayoutBuilder(
  builder: (_, box) => SingleChildScrollView(
    physics: const AlwaysScrollableScrollPhysics(),
    child: SizedBox(height: box.maxHeight, child: child),
  ),
);

class _MonthBody extends StatelessWidget {
  const _MonthBody({required this.month, required this.history});
  final DateTime month;
  final LiveHistoryMonth history;

  @override
  Widget build(BuildContext context) {
    if (history.days.isEmpty) {
      return _scrollable(
        EmptyState(
          icon: Icons.history_toggle_off,
          title: 'No broadcasts in ${_monthLabel.format(month)}',
        ),
      );
    }
    return ListView.builder(
      physics: const AlwaysScrollableScrollPhysics(),
      padding: EdgeInsets.only(
        bottom: 16 + MediaQuery.paddingOf(context).bottom,
      ),
      itemCount: history.days.length + 1,
      itemBuilder: (_, i) => i == 0
          ? _MonthSummary(history: history)
          : _DayTile(day: history.days[i - 1]),
    );
  }
}

/// Total time, live days and lives for the month, on the brand gradient.
class _MonthSummary extends StatelessWidget {
  const _MonthSummary({required this.history});
  final LiveHistoryMonth history;

  @override
  Widget build(BuildContext context) {
    Widget stat(String value, String label) => Expanded(
      child: Semantics(
        label: '$label $value',
        excludeSemantics: true,
        child: Column(
          children: [
            FittedBox(
              fit: BoxFit.scaleDown,
              child: Text(
                value,
                style: const TextStyle(
                  color: BBColors.ink,
                  fontSize: 18,
                  fontWeight: FontWeight.w800,
                  fontFeatures: [FontFeature.tabularFigures()],
                ),
              ),
            ),
            const SizedBox(height: 2),
            Text(
              label,
              style: const TextStyle(color: BBColors.bronzeDeep, fontSize: 12),
            ),
          ],
        ),
      ),
    );
    return Container(
      margin: const EdgeInsets.fromLTRB(16, 12, 16, 8),
      padding: const EdgeInsets.symmetric(vertical: 14, horizontal: 4),
      decoration: BoxDecoration(
        gradient: BBColors.goldGradient,
        borderRadius: BorderRadius.circular(12),
        boxShadow: const [
          BoxShadow(
            color: BBColors.goldShadow,
            blurRadius: 12,
            offset: Offset(0, 4),
          ),
        ],
      ),
      child: Row(
        children: [
          stat(Fmt.duration(history.totalSeconds), 'Total time'),
          stat('${history.liveDays}', 'Live days'),
          stat('${history.sessionCount}', 'Lives'),
        ],
      ),
    );
  }
}

String _lives(int n) => '$n ${n == 1 ? 'live' : 'lives'}';

/// One day: its date, total time, and how its lives did. Opens that day's lives.
class _DayTile extends StatelessWidget {
  const _DayTile({required this.day});
  final LiveHistoryDay day;

  void _openSessions(BuildContext context) => showModalBottomSheet<void>(
    context: context,
    showDragHandle: true,
    isScrollControlled: true,
    builder: (sheet) => ConstrainedBox(
      constraints: BoxConstraints(
        maxHeight: MediaQuery.sizeOf(sheet).height * 0.7,
      ),
      child: SafeArea(
        top: false,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
              child: Text(
                '${_dayHeader.format(day.date)}  ·  ${Fmt.duration(day.totalSeconds)}',
                textAlign: TextAlign.center,
                style: const TextStyle(
                  fontSize: 16,
                  fontWeight: FontWeight.w600,
                ),
              ),
            ),
            Flexible(
              child: ListView(
                shrinkWrap: true,
                padding: const EdgeInsets.only(bottom: 16),
                children: [
                  for (final h in day.sessions)
                    ListTile(
                      onTap: () {
                        Navigator.pop(sheet);
                        context.push('/live-summary/${h.id}');
                      },
                      leading: Icon(
                        h.isAudio ? Icons.mic_rounded : Icons.videocam_rounded,
                        color: BBColors.gold,
                      ),
                      title: Text(
                        h.label,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                      ),
                      subtitle: Text(
                        [
                          _clock.format(h.startedAt),
                          Fmt.duration(h.durationSec),
                          'peak ${Fmt.compact(h.peakViewers)} viewers',
                          '💎 ${Fmt.compact(h.diamonds)} earned',
                        ].join(' · '),
                        style: const TextStyle(color: BBColors.inkMuted),
                      ),
                      trailing: const Icon(
                        Icons.chevron_right_rounded,
                        color: BBColors.inkSubtle,
                      ),
                    ),
                ],
              ),
            ),
          ],
        ),
      ),
    ),
  );

  @override
  Widget build(BuildContext context) => ListTile(
    onTap: () => _openSessions(context),
    contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 4),
    leading: Container(
      width: 48,
      height: 48,
      decoration: BoxDecoration(
        color: BBColors.surfaceMuted,
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: BBColors.border),
      ),
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Text(
            '${day.date.day}',
            style: const TextStyle(
              fontSize: 18,
              fontWeight: FontWeight.w700,
              height: 1.1,
            ),
          ),
          Text(
            _weekday.format(day.date),
            style: const TextStyle(color: BBColors.inkMuted, fontSize: 11),
          ),
        ],
      ),
    ),
    title: Text(
      Fmt.duration(day.totalSeconds),
      style: const TextStyle(fontWeight: FontWeight.w600),
    ),
    subtitle: Text(
      [
        _lives(day.sessionCount),
        'peak ${Fmt.compact(day.peakViewers)} viewers',
        '💎 ${Fmt.compact(day.diamonds)} earned',
      ].join(' · '),
      style: const TextStyle(color: BBColors.inkMuted),
    ),
    trailing: const Icon(
      Icons.chevron_right_rounded,
      color: BBColors.inkSubtle,
    ),
  );
}

/// A year switcher over a 4×3 grid of months; months outside [first]..[last] are disabled.
class _MonthPicker extends StatefulWidget {
  const _MonthPicker({
    required this.selected,
    required this.first,
    required this.last,
  });
  final DateTime selected;
  final DateTime first;
  final DateTime last;

  @override
  State<_MonthPicker> createState() => _MonthPickerState();
}

class _MonthPickerState extends State<_MonthPicker> {
  late int _year = widget.selected.year;

  @override
  Widget build(BuildContext context) => SafeArea(
    child: Padding(
      padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Row(
            children: [
              IconButton(
                tooltip: 'Previous year',
                onPressed: _year > widget.first.year
                    ? () => setState(() => _year--)
                    : null,
                icon: const Icon(Icons.chevron_left_rounded),
              ),
              Expanded(
                child: Text(
                  '$_year',
                  textAlign: TextAlign.center,
                  style: const TextStyle(
                    fontSize: 18,
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ),
              IconButton(
                tooltip: 'Next year',
                onPressed: _year < widget.last.year
                    ? () => setState(() => _year++)
                    : null,
                icon: const Icon(Icons.chevron_right_rounded),
              ),
            ],
          ),
          const SizedBox(height: 8),
          GridView.count(
            crossAxisCount: 4,
            shrinkWrap: true,
            physics: const NeverScrollableScrollPhysics(),
            mainAxisSpacing: 8,
            crossAxisSpacing: 8,
            childAspectRatio: 2,
            children: [for (var m = 1; m <= 12; m++) _cell(DateTime(_year, m))],
          ),
        ],
      ),
    ),
  );

  Widget _cell(DateTime month) {
    final enabled =
        !month.isBefore(widget.first) && !month.isAfter(widget.last);
    final selected = month == widget.selected;
    return Material(
      color: selected ? BBColors.gold : BBColors.surfaceMuted,
      borderRadius: BorderRadius.circular(8),
      child: InkWell(
        borderRadius: BorderRadius.circular(8),
        onTap: enabled ? () => Navigator.pop(context, month) : null,
        child: Center(
          child: Text(
            _shortMonth.format(month),
            style: TextStyle(
              color: selected
                  ? BBColors.onAccent
                  : enabled
                  ? BBColors.ink
                  : BBColors.inkSubtle,
              fontWeight: selected ? FontWeight.w700 : null,
            ),
          ),
        ),
      ),
    );
  }
}
