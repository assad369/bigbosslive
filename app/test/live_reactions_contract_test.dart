import 'dart:io';

import 'package:bigboss_live/models/models.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('LiveReaction matches LIVE_REACTIONS in packages/shared, in order', () {
    final source = File('../packages/shared/src/constants.ts')
        .readAsStringSync();
    final start = source.indexOf('export const LIVE_REACTIONS');
    final block = source.substring(start, source.indexOf('] as const;', start));
    final names = RegExp(r"'([a-z_]+)'").allMatches(block).map((m) => m[1]);
    expect(names, LiveReaction.values.map((r) => r.name));
  });

  test('an unknown name is skipped, not a crash', () {
    expect(LiveReaction.fromName('fire'), LiveReaction.fire);
    expect(LiveReaction.fromName('from_the_future'), isNull);
    expect(LiveReaction.fromName(null), isNull);
  });
}
