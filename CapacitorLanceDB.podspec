require 'json'

package = JSON.parse(File.read(File.join(File.dirname(__FILE__), 'package.json')))

Pod::Spec.new do |s|
  s.name = 'CapacitorLanceDB'
  s.version = package['version']
  s.summary = package['description']
  s.license = package['license']
  s.homepage = 'https://github.com/rogelioRuiz/capacitor-lancedb'
  s.author = 'Techxagon'
  s.source = { :git => 'https://github.com/rogelioRuiz/capacitor-lancedb.git', :tag => s.version.to_s }

  s.source_files = 'ios/Sources/**/*.swift'
  s.ios.deployment_target = '14.0'

  s.dependency 'Capacitor'
  s.swift_version = '5.9'

  # Prebuilt Rust xcframework
  s.vendored_frameworks = 'ios/Frameworks/LanceDBFFI.xcframework'
end
