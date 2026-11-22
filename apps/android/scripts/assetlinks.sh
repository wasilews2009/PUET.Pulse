#!/usr/bin/env bash
# Prints the Digital Asset Links file that lets the PUET.Pulse server vouch for
# the Android app (without it Android shows an address bar above the app).
# Publish the output at https://<server>/.well-known/assetlinks.json.
#
#   scripts/assetlinks.sh AB:CD:...:EF [more fingerprints]
#   scripts/assetlinks.sh --keystore release.jks --alias puet-pulse   (asks for the password)
#
# Give every key the app is signed with: your upload / release key and, for
# Google Play, the "App signing key" SHA-256 from Play Console > App integrity.
set -euo pipefail
PACKAGE="${PULSE_ANDROID_PACKAGE:-ua.edu.puet.pulse}"
fps=()
if [[ "${1:-}" == "--keystore" ]]; then
  ks="$2"; alias="${4:?--alias NAME}"
  fps+=("$(keytool -list -v -keystore "$ks" -alias "$alias" | awk '/SHA256:/{print $2; exit}')")
else
  fps=("$@")
fi
[[ ${#fps[@]} -gt 0 ]] || { echo "usage: $0 FINGERPRINT... | --keystore FILE --alias NAME" >&2; exit 2; }
list=""
for fp in "${fps[@]}"; do
  [[ "$fp" =~ ^([0-9A-F]{2}:){31}[0-9A-F]{2}$ ]] || { echo "not a SHA-256 fingerprint: $fp" >&2; exit 2; }
  list+="${list:+, }\"$fp\""
done
cat <<JSON
[
  {
    "relation": ["delegate_permission/common.handle_all_urls"],
    "target": {
      "namespace": "android_app",
      "package_name": "$PACKAGE",
      "sha256_cert_fingerprints": [$list]
    }
  }
]
JSON
