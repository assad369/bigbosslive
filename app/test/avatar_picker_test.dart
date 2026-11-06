import 'dart:io';
import 'dart:typed_data';

import 'package:bigboss_live/core/media/avatar_picker.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:image/image.dart' as img;
import 'package:image_picker/image_picker.dart';

Uint8List _ascii(String s) => Uint8List.fromList(s.codeUnits);

/// A RIFF/WEBP header whose first chunk is [chunk], with [flags] as its first payload byte.
Uint8List _webp(String chunk, {int flags = 0}) => Uint8List.fromList([
  ..._ascii('RIFF'),
  0, 0, 0, 0, // file size (unused by the sniffer)
  ..._ascii('WEBP'),
  ..._ascii(chunk),
  10, 0, 0, 0, // chunk size
  flags,
  ...List.filled(11, 0),
]);

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

void main() {
  late Directory tmp;
  setUp(() => tmp = Directory.systemTemp.createTempSync('avatar_test'));
  tearDown(() => tmp.deleteSync(recursive: true));

  File write(String name, List<int> bytes) =>
      File('${tmp.path}/$name')..writeAsBytesSync(bytes);

  group('sniffImageKind', () {
    test('reads the real type from magic bytes', () {
      expect(sniffImageKind(_ascii('GIF87a....')), ImageKind.gif);
      expect(sniffImageKind(_ascii('GIF89a....')), ImageKind.gif);
      expect(
        sniffImageKind(
          Uint8List.fromList([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
        ),
        ImageKind.png,
      );
      expect(
        sniffImageKind(Uint8List.fromList([0xFF, 0xD8, 0xFF, 0xE0])),
        ImageKind.jpeg,
      );
      expect(sniffImageKind(_ascii('hello world')), ImageKind.other);
      expect(sniffImageKind(Uint8List(0)), ImageKind.other);
    });

    test('tells animated WebP from still WebP', () {
      expect(sniffImageKind(_webp('VP8 ')), ImageKind.webp);
      expect(sniffImageKind(_webp('VP8L')), ImageKind.webp);
      // VP8X with only the alpha flag set.
      expect(sniffImageKind(_webp('VP8X', flags: 0x10)), ImageKind.webp);
      expect(
        sniffImageKind(_webp('VP8X', flags: 0x12)),
        ImageKind.animatedWebp,
      );
    });

    test('a real encoded GIF sniffs as GIF', () {
      expect(sniffImageKind(_animatedGif()), ImageKind.gif);
    });
  });

  test('mimeFor', () {
    expect(mimeFor(ImageKind.gif), 'image/gif');
    expect(mimeFor(ImageKind.animatedWebp), 'image/webp');
    expect(mimeFor(ImageKind.webp), 'image/webp');
    expect(mimeFor(ImageKind.png), 'image/png');
    expect(mimeFor(ImageKind.jpeg), 'image/jpeg');
  });

  group('pickAvatar', () {
    test('keeps an animated GIF byte for byte, whatever its name', () async {
      final bytes = _animatedGif();
      // Named like Android's picker output: the extension says nothing.
      final f = write('scaled_photo.jpg', bytes);
      final picked = await pickAvatar(pick: () async => XFile(f.path));
      expect(picked, isNotNull);
      expect(picked!.animated, isTrue);
      expect(picked.contentType, 'image/gif');
      expect(picked.file.path, f.path);
      expect(picked.file.readAsBytesSync(), bytes);
    });

    test('rejects an animation over the upload cap', () async {
      final f = write('big.gif', [
        ..._ascii('GIF89a'),
        ...Uint8List(avatarMaxBytes),
      ]);
      await expectLater(
        pickAvatar(pick: () async => XFile(f.path)),
        throwsA(isA<AvatarTooLarge>()),
      );
    });

    test('returns null when the user cancels', () async {
      expect(await pickAvatar(pick: () async => null), isNull);
    });
  });

  group('prepareAvatar stills', () {
    testWidgets('downscales a large JPEG to fit 720 px', (tester) async {
      final src = img.Image(width: 1440, height: 960, numChannels: 3)
        ..clear(img.ColorRgb8(10, 120, 200));
      final f = write('photo.jpg', img.encodeJpg(src));
      final picked = (await tester.runAsync(() => prepareAvatar(f)))!;
      expect(picked.animated, isFalse);
      expect(picked.contentType, 'image/jpeg');
      expect(picked.file.path, isNot(f.path));
      final out = img.decodeJpg(picked.file.readAsBytesSync())!;
      expect([out.width, out.height], [720, 480]);
    });

    testWidgets('keeps PNG (and its alpha) when downscaling', (tester) async {
      final src = img.Image(width: 800, height: 1600, numChannels: 4)
        ..clear(img.ColorRgba8(0, 0, 0, 0));
      final f = write('logo.png', img.encodePng(src));
      final picked = (await tester.runAsync(() => prepareAvatar(f)))!;
      expect(picked.contentType, 'image/png');
      final out = img.decodePng(picked.file.readAsBytesSync())!;
      expect([out.width, out.height], [360, 720]);
    });

    testWidgets('uploads a small still unchanged', (tester) async {
      final src = img.Image(width: 300, height: 300, numChannels: 3);
      final f = write('small.png', img.encodePng(src));
      final picked = (await tester.runAsync(() => prepareAvatar(f)))!;
      expect(picked.file.path, f.path);
      expect(picked.contentType, 'image/png');
    });

    testWidgets('rejects a file that is not an image', (tester) async {
      final f = write('notes.txt', _ascii('definitely not an image'));
      Object? error;
      await tester.runAsync(() async {
        try {
          await prepareAvatar(f);
        } catch (e) {
          error = e;
        }
      });
      expect(error, isA<AvatarUnreadable>());
    });
  });
}
