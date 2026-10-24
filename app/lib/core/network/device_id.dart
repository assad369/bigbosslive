import 'package:shared_preferences/shared_preferences.dart';
import 'package:uuid/uuid.dart';

/// A stable per-install id sent as `X-Device-Id` (used for device bans and session lists).
class DeviceId {
  DeviceId._(this.value);
  final String value;

  static const _key = 'bb.device_id';

  static Future<DeviceId> load() async {
    final prefs = await SharedPreferences.getInstance();
    var id = prefs.getString(_key);
    if (id == null) {
      id = 'bb-${const Uuid().v4()}';
      await prefs.setString(_key, id);
    }
    return DeviceId._(id);
  }
}
