import 'package:bigboss_live/core/router/app_router.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('push payloads map to routes', () {
    expect(routeForLink({'type': 'live', 'roomId': 'abc'}), '/live/abc');
    expect(routeForLink({'type': 'chat', 'conversationId': 'c1'}), '/chat/c1');
    expect(routeForLink({'type': 'follow', 'userId': 'u1'}), '/user/u1');
    expect(routeForLink({'type': 'withdrawal'}), '/wallet');
    expect(routeForLink({'type': 'system'}), '/notifications');
    expect(routeForLink({'url': 'bigboss://vip'}), '/vip');
    expect(routeForLink({'url': 'https://evil.example'}), isNull);
    expect(routeForLink({}), isNull);
  });
}
