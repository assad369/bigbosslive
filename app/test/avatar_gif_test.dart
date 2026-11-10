import 'dart:io';
import 'dart:typed_data';

import 'package:bigboss_live/core/widgets/widgets.dart';
import 'package:bigboss_live/models/models.dart';
import 'package:file/local.dart';
import 'package:flutter/material.dart';
import 'package:flutter_cache_manager/flutter_cache_manager.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:image/image.dart' as img;

/// A two-frame GIF: red, then blue, 100 ms each, looping.
Uint8List _animatedGif() {
  final first = img.Image(width: 40, height: 40, numChannels: 3)
    ..clear(img.ColorRgb8(255, 0, 0));
  first.frameDuration = 100;
  final second = img.Image(width: 40, height: 40, numChannels: 3)
    ..clear(img.ColorRgb8(0, 0, 255));
  second.frameDuration = 100;
  first.addFrame(second);
  return img.encodeGif(first);
}

/// Serves every URL from one local file, as if it were cached.
class _FileCache extends Fake implements BaseCacheManager {
  _FileCache(this.file);
  final File file;

  @override
  Stream<FileResponse> getFileStream(
    String url, {
    String? key,
    Map<String, String>? headers,
    bool withProgress = false,
  }) => Stream.value(
    FileInfo(
      const LocalFileSystem().file(file.path),
      FileSource.Cache,
      DateTime.now().add(const Duration(days: 1)),
      url,
    ),
  );
}

void main() {
  late Directory tmp;
  setUp(() => tmp = Directory.systemTemp.createTempSync('avatar_gif'));
  tearDown(() {
    BBAvatar.debugCacheManager = null;
    tmp.deleteSync(recursive: true);
  });

  /// The image the avatar shows right now.
  Future<Object?> shownFrame(WidgetTester tester) async {
    final image = find.descendant(
      of: find.byType(BBAvatar),
      matching: find.byType(RawImage),
    );
    if (image.evaluate().isEmpty) return null;
    return tester.widget<RawImage>(image).image;
  }

  /// Lets the codec decode in real time, then draws the frame.
  Future<void> settleFrames(WidgetTester tester, Duration fake) async {
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(milliseconds: 50)),
    );
    await tester.pump(fake);
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(milliseconds: 50)),
    );
    await tester.pump();
  }

  testWidgets('a GIF profile picture animates in BBAvatar', (tester) async {
    final file = File('${tmp.path}/avatar.gif')
      ..writeAsBytesSync(_animatedGif());
    BBAvatar.debugCacheManager = _FileCache(file);

    await tester.pumpWidget(
      MaterialApp(
        home: Center(
          child: BBAvatar.user(
            const UserBrief(
              id: 'u1',
              shortId: '201',
              displayName: 'Gif',
              avatarUrl: 'https://cdn.test/avatars/u1/a.gif',
            ),
            size: 58,
          ),
        ),
      ),
    );
    Object? first;
    for (var i = 0; i < 20 && first == null; i++) {
      await settleFrames(tester, Duration.zero);
      first = await shownFrame(tester);
    }
    expect(first, isNotNull, reason: 'the GIF never loaded');

    // Advance past the first frame's 100 ms: the second frame replaces it.
    final seen = <Object?>{first};
    for (var i = 0; i < 6; i++) {
      await settleFrames(tester, const Duration(milliseconds: 110));
      final frame = await shownFrame(tester);
      if (frame != null) seen.add(frame);
    }
    expect(seen.length, greaterThan(1), reason: 'stuck on the first frame');
  });
}
