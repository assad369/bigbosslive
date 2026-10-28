import 'package:flutter/material.dart';
import 'package:google_fonts/google_fonts.dart';

import 'bb_colors.dart';

/// The app has one light theme built from [BBColors]. `ColorScheme` is a projection of the
/// tokens, never the source of truth.
abstract final class BBTheme {
  /// Manrope for UI text, Playfair Display for display/headline styles. Built from the
  /// framework's typography with font families swapped, so sizes and metrics stay Material.
  static TextTheme _text() {
    final ui = GoogleFonts.manrope().fontFamily;
    final display = GoogleFonts.playfairDisplay().fontFamily;
    final base = Typography.material2021(platform: TargetPlatform.android).black
        .apply(
          fontFamily: ui,
          bodyColor: BBColors.ink,
          displayColor: BBColors.ink,
        );
    TextStyle? serif(TextStyle? s) =>
        s?.copyWith(fontFamily: display, fontWeight: FontWeight.w700);
    return base.copyWith(
      displayLarge: serif(base.displayLarge),
      displayMedium: serif(base.displayMedium),
      displaySmall: serif(base.displaySmall),
      headlineLarge: serif(base.headlineLarge),
      headlineMedium: serif(base.headlineMedium),
      headlineSmall: serif(base.headlineSmall),
      titleLarge: base.titleLarge?.copyWith(fontWeight: FontWeight.w700),
      titleMedium: base.titleMedium?.copyWith(fontWeight: FontWeight.w600),
      labelLarge: base.labelLarge?.copyWith(fontWeight: FontWeight.w700),
    );
  }

  static ThemeData light() {
    const scheme = ColorScheme(
      brightness: Brightness.light,
      primary: BBColors.goldDeep,
      onPrimary: BBColors.surface,
      primaryContainer: BBColors.champagne,
      onPrimaryContainer: BBColors.bronzeDeep,
      secondary: BBColors.bronze,
      onSecondary: BBColors.surface,
      secondaryContainer: BBColors.surfaceMuted,
      onSecondaryContainer: BBColors.bronzeDeep,
      tertiary: BBColors.gold,
      onTertiary: BBColors.ink,
      error: BBColors.danger,
      onError: BBColors.surface,
      surface: BBColors.surface,
      onSurface: BBColors.ink,
      onSurfaceVariant: BBColors.inkMuted,
      surfaceContainerLowest: BBColors.surface,
      surfaceContainerLow: BBColors.ivory,
      surfaceContainer: BBColors.surfaceMuted,
      surfaceContainerHigh: BBColors.champagne,
      outline: BBColors.border,
      outlineVariant: BBColors.border,
      shadow: BBColors.ink,
    );
    final text = _text();
    final radius = BorderRadius.circular(14);
    return ThemeData(
      useMaterial3: true,
      colorScheme: scheme,
      scaffoldBackgroundColor: BBColors.ivory,
      textTheme: text,
      splashFactory: InkSparkle.splashFactory,
      appBarTheme: AppBarTheme(
        backgroundColor: BBColors.ivory,
        foregroundColor: BBColors.ink,
        elevation: 0,
        scrolledUnderElevation: 0.5,
        centerTitle: false,
        titleTextStyle: text.titleLarge,
      ),
      cardTheme: CardThemeData(
        color: BBColors.surface,
        elevation: 0,
        margin: EdgeInsets.zero,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(18),
          side: const BorderSide(color: BBColors.border),
        ),
      ),
      filledButtonTheme: FilledButtonThemeData(
        style: FilledButton.styleFrom(
          backgroundColor: BBColors.goldDeep,
          foregroundColor: BBColors.surface,
          // Tall but not infinitely wide: `Size.fromHeight` made every button demand the
          // full width, which stacks dialog actions and breaks buttons in rows and list
          // tiles. Call sites that want a full-width button say so.
          minimumSize: const Size(64, 50),
          shape: RoundedRectangleBorder(borderRadius: radius),
          textStyle: text.labelLarge,
        ),
      ),
      outlinedButtonTheme: OutlinedButtonThemeData(
        style: OutlinedButton.styleFrom(
          foregroundColor: BBColors.bronzeDeep,
          minimumSize: const Size(64, 48),
          side: const BorderSide(color: BBColors.champagneDeep),
          shape: RoundedRectangleBorder(borderRadius: radius),
        ),
      ),
      textButtonTheme: TextButtonThemeData(
        style: TextButton.styleFrom(foregroundColor: BBColors.bronze),
      ),
      inputDecorationTheme: InputDecorationTheme(
        filled: true,
        fillColor: BBColors.surface,
        contentPadding: const EdgeInsets.symmetric(
          horizontal: 16,
          vertical: 14,
        ),
        border: OutlineInputBorder(
          borderRadius: radius,
          borderSide: const BorderSide(color: BBColors.border),
        ),
        enabledBorder: OutlineInputBorder(
          borderRadius: radius,
          borderSide: const BorderSide(color: BBColors.border),
        ),
        focusedBorder: OutlineInputBorder(
          borderRadius: radius,
          borderSide: const BorderSide(color: BBColors.gold, width: 1.6),
        ),
        hintStyle: const TextStyle(color: BBColors.inkSubtle),
      ),
      chipTheme: ChipThemeData(
        backgroundColor: BBColors.surfaceMuted,
        selectedColor: BBColors.champagne,
        side: const BorderSide(color: BBColors.border),
        labelStyle: text.labelMedium,
        shape: const StadiumBorder(),
      ),
      tabBarTheme: TabBarThemeData(
        labelColor: BBColors.ink,
        unselectedLabelColor: BBColors.inkSubtle,
        labelStyle: text.titleSmall?.copyWith(fontWeight: FontWeight.w800),
        indicator: const UnderlineTabIndicator(
          borderSide: BorderSide(color: BBColors.gold, width: 3),
        ),
        indicatorSize: TabBarIndicatorSize.label,
        dividerColor: Colors.transparent,
      ),
      navigationBarTheme: NavigationBarThemeData(
        backgroundColor: BBColors.surface,
        indicatorColor: BBColors.champagne,
        elevation: 0,
        labelTextStyle: WidgetStatePropertyAll(
          text.labelSmall?.copyWith(fontWeight: FontWeight.w600),
        ),
        iconTheme: WidgetStateProperty.resolveWith(
          (s) => IconThemeData(
            color: s.contains(WidgetState.selected)
                ? BBColors.goldDeep
                : BBColors.inkSubtle,
          ),
        ),
      ),
      bottomSheetTheme: const BottomSheetThemeData(
        backgroundColor: BBColors.surface,
        showDragHandle: true,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.vertical(top: Radius.circular(24)),
        ),
      ),
      dialogTheme: DialogThemeData(
        backgroundColor: BBColors.surface,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(22)),
      ),
      snackBarTheme: SnackBarThemeData(
        behavior: SnackBarBehavior.floating,
        backgroundColor: BBColors.ink,
        contentTextStyle: text.bodyMedium?.copyWith(color: BBColors.ivory),
        shape: RoundedRectangleBorder(borderRadius: radius),
      ),
      dividerTheme: const DividerThemeData(
        color: BBColors.border,
        thickness: 1,
        space: 1,
      ),
      listTileTheme: const ListTileThemeData(iconColor: BBColors.bronze),
      progressIndicatorTheme: const ProgressIndicatorThemeData(
        color: BBColors.gold,
      ),
    );
  }
}
