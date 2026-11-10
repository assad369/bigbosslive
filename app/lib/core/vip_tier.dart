import 'package:flutter/material.dart';

import 'theme/bb_colors.dart';

/// The tier ladder: VIP < VVIP < Crown < King. Mirrors `VIP_TIERS` in `packages/shared`;
/// the index is the server's `vipTier` (0 = none), so it is also the rank.
///
/// Every surface that labels or colours a tier reads it from here, so the ladder lives in
/// one place on the client.
enum VipTier {
  none,
  vip,
  vvip,
  crown,
  king;

  static VipTier of(int tier) =>
      tier >= 1 && tier < values.length ? values[tier] : none;

  /// From the shop route's key (`vip`, `vvip`, `crown`, `king`); null for anything else.
  static VipTier? byKey(String key) {
    for (final t in values) {
      if (t != none && t.name == key) return t;
    }
    return null;
  }

  /// The server's number (1–4).
  int get number => index;

  String get label => switch (this) {
    none => '',
    vip => 'VIP',
    vvip => 'VVIP',
    crown => 'Crown',
    king => 'King',
  };

  IconData get icon => switch (this) {
    king => Icons.military_tech,
    crown => Icons.star_rounded,
    vvip => Icons.auto_awesome,
    _ => Icons.workspace_premium,
  };

  /// Pill fill.
  Color get color => switch (this) {
    vip => BBColors.vip,
    vvip => BBColors.vvip,
    crown => BBColors.crown,
    king => BBColors.king,
    none => BBColors.inkSubtle,
  };

  /// Text and icon on [color].
  Color get onColor => switch (this) {
    vvip || crown => BBColors.ink,
    _ => BBColors.onAccent,
  };

  /// Chat bubble tint for messages from a holder of this tier.
  Color get tint => switch (this) {
    vip => BBColors.vip,
    vvip => BBColors.vvipDeep,
    crown => BBColors.crownDeep,
    king => BBColors.king,
    none => BBColors.inkSubtle,
  };

  LinearGradient? get gradient => BBColors.tierGradient(index);
}
