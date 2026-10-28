import 'package:flutter/material.dart';

/// BigBoss Live "Champagne" palette — warm ivory surfaces, deep-gold brand, bronze accents.
///
/// Mirrors `packages/shared/src/theme.ts`; change both in the same commit. Never inline a hex
/// value at a call site — add or reuse a token here.
abstract final class BBColors {
  static const ivory = Color(0xFFFBF7EF);
  static const surface = Color(0xFFFFFFFF);
  static const surfaceMuted = Color(0xFFF6EFE1);
  static const champagne = Color(0xFFF3E5C3);
  static const champagneDeep = Color(0xFFE8D3A2);
  static const gold = Color(0xFFC9A227);
  static const goldDeep = Color(0xFFB8860B);
  static const goldLight = Color(0xFFE9CF7A);
  static const bronze = Color(0xFF8C6239);
  static const bronzeDeep = Color(0xFF6B4826);
  static const ink = Color(0xFF2B2118);
  static const inkMuted = Color(0xFF6E5E4B);
  static const inkSubtle = Color(0xFFA3927C);
  static const border = Color(0xFFEADFC8);
  static const success = Color(0xFF3F8F5A);
  static const warning = Color(0xFFD08A1E);
  static const danger = Color(0xFFB4443A);
  static const info = Color(0xFF3C6E8F);

  /// Immersive surfaces (live rooms, games) sit on a warm espresso base.
  static const espresso = Color(0xFF1D1610);
  static const scrim = Color(0x8C2B2118);

  /// Darkens a room background image under the audio seat grid.
  static const espressoShade = Color(0xAA1D1610);

  /// Translucent gold for system lines and empty-seat outlines on live video.
  static const goldTint = Color(0x33E9CF7A);
  static const goldOutline = Color(0x55E9CF7A);
  static const champagneTint = Color(0x22F3E5C3);

  /// PK sides: the room's own host is always red, the opponent blue.
  static const pkRed = Color(0xFFD64545);
  static const pkBlue = Color(0xFF3D7BD9);
  static const heart = Color(0xFFE5486B);

  /// VIP ladder: VIP purple, VVIP gold, King crimson. Rings, badges, entrance banners.
  static const vip = Color(0xFFA855F7);
  static const vipDeep = Color(0xFF7E22CE);
  static const vvip = Color(0xFFF4C542);
  static const vvipDeep = Color(0xFFC98A0B);
  static const king = Color(0xFFD7263D);
  static const kingDeep = Color(0xFF8E0F22);

  static const vipGradient = LinearGradient(
    begin: Alignment.topLeft,
    end: Alignment.bottomRight,
    colors: [vip, vipDeep],
  );
  static const vvipGradient = LinearGradient(
    begin: Alignment.topLeft,
    end: Alignment.bottomRight,
    colors: [vvip, vvipDeep],
  );
  static const kingGradient = LinearGradient(
    begin: Alignment.topLeft,
    end: Alignment.bottomRight,
    colors: [goldLight, king, kingDeep],
    stops: [0, 0.45, 1],
  );

  /// Gradient for a `vipTier` (1 VIP, 2 VVIP, 3 King); null when there is no tier.
  static LinearGradient? tierGradient(int tier) => switch (tier) {
    1 => vipGradient,
    2 => vvipGradient,
    >= 3 => kingGradient,
    _ => null,
  };

  static Color tierColor(int tier) => switch (tier) {
    1 => vip,
    2 => vvipDeep,
    >= 3 => king,
    _ => inkSubtle,
  };

  static const goldGradient = LinearGradient(
    begin: Alignment.topLeft,
    end: Alignment.bottomRight,
    colors: [goldLight, gold, goldDeep],
    stops: [0, 0.45, 1],
  );

  static const champagneGradient = LinearGradient(
    begin: Alignment.topCenter,
    end: Alignment.bottomCenter,
    colors: [surface, champagne],
  );

  static const bronzeGradient = LinearGradient(
    begin: Alignment.topLeft,
    end: Alignment.bottomRight,
    colors: [Color(0xFFB07D4F), bronze, bronzeDeep],
  );

  /// Bottom-up scrim that keeps overlay text readable on live video.
  static const videoScrim = LinearGradient(
    begin: Alignment.bottomCenter,
    end: Alignment.topCenter,
    colors: [Color(0xCC1D1610), Color(0x001D1610)],
  );
}
