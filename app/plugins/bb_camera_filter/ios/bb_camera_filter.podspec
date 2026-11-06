# Used only if Swift Package Manager is turned off for the app (it is on today).
Pod::Spec.new do |s|
  s.name             = 'bb_camera_filter'
  s.version          = '1.0.0'
  s.summary          = 'Native camera filters for flutter_webrtc local video tracks.'
  s.homepage         = 'https://bigbosslive.com'
  s.license          = { :type => 'Proprietary' }
  s.author           = { 'BigBoss Live' => 'dev@bigbosslive.com' }
  s.source           = { :path => '.' }
  s.source_files     = 'bb_camera_filter/Sources/bb_camera_filter/**/*.{h,m}'
  s.public_header_files = 'bb_camera_filter/Sources/bb_camera_filter/include/**/*.h'
  s.dependency 'Flutter'
  s.dependency 'flutter_webrtc'
  s.dependency 'WebRTC-SDK', '150.7871.04'
  s.frameworks = 'CoreImage', 'Metal'
  s.ios.deployment_target = '13.0'
  s.static_framework = true
end
