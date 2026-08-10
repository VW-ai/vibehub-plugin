#!/bin/sh
# Assemble a runnable VibeHub Workbench.app around the swift build product.
# No signing identity, no installer, no login item: the bundle exists so macOS
# gives the shell a real application identity, Dock tile, and menu bar.
set -eu

package_root=$(cd "$(dirname "$0")/.." && pwd)
configuration=${1:-debug}
binary="$package_root/.build/$configuration/VibeHubWorkbench"
bundle="$package_root/.build/VibeHub Workbench.app"

swift build --package-path "$package_root" $([ "$configuration" = release ] && echo -c release)

rm -rf "$bundle"
mkdir -p "$bundle/Contents/MacOS"
cp "$binary" "$bundle/Contents/MacOS/VibeHubWorkbench"
cat > "$bundle/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key><string>VibeHubWorkbench</string>
  <key>CFBundleIdentifier</key><string>dev.vibehub.workbench</string>
  <key>CFBundleName</key><string>VibeHub Workbench</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.5.0</string>
  <key>CFBundleVersion</key><string>0.5.0</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
PLIST

printf '%s\n' "$bundle"
