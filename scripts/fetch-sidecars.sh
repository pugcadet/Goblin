#!/usr/bin/env bash
# Puts ffmpeg, ffprobe and deno for this computer into src-tauri/binaries/, named the way
# Tauri expects (<name>-<target triple>[.exe]). They are shipped inside the app, next to Goblin.
#
#   scripts/fetch-sidecars.sh                      # for this computer (Mac or Windows, in Git Bash)
#   TRIPLE=x86_64-apple-darwin scripts/fetch-sidecars.sh
#
# deno and the Windows ffmpeg are checked against their published SHA-256 checksums.
set -euo pipefail
cd "$(dirname "$0")/.."

OUT=src-tauri/binaries
mkdir -p "$OUT"
TRIPLE="${TRIPLE:-$(rustc -vV | sed -n 's/^host: //p')}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

case "$TRIPLE" in
  aarch64-apple-darwin | x86_64-apple-darwin) os=mac; ext="" ;;
  x86_64-pc-windows-msvc) os=win; ext=".exe" ;;
  *) echo "✗ Unsupported computer: $TRIPLE"; exit 1 ;;
esac

dl() {
  echo "  ↓ $1"
  curl -fL --proto '=https' --tlsv1.2 --retry 3 --retry-delay 3 --connect-timeout 20 --max-time 900 -sS -o "$2" "$1"
}
sha() { if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }
check() {
  local want got
  want="$(printf '%s' "$2" | tr 'A-F' 'a-f')"
  got="$(sha "$1")"
  [[ -n "$want" && "$got" == "$want" ]] || { echo "✗ Checksum mismatch for $(basename "$1")"; exit 1; }
  echo "  ✓ checksum ok"
}

echo "→ deno ($TRIPLE)"
D="https://github.com/denoland/deno/releases/latest/download/deno-$TRIPLE.zip"
dl "$D" "$TMP/deno.zip"
dl "$D.sha256sum" "$TMP/deno.sha"
check "$TMP/deno.zip" "$(grep -oiE '[0-9a-f]{64}' "$TMP/deno.sha" | head -1)"
unzip -oq "$TMP/deno.zip" -d "$TMP/deno"
install -m 755 "$TMP/deno/deno$ext" "$OUT/deno-$TRIPLE$ext"

echo "→ ffmpeg + ffprobe"
if [[ $os == win ]]; then
  # BtbN's static Windows builds (GitHub releases, with a checksum list).
  B=https://github.com/BtbN/FFmpeg-Builds/releases/download/latest
  N=ffmpeg-master-latest-win64-gpl
  dl "$B/$N.zip" "$TMP/ff.zip"
  dl "$B/checksums.sha256" "$TMP/ff.sha"
  check "$TMP/ff.zip" "$(grep -E "[[:space:]]$N\.zip\$" "$TMP/ff.sha" | tr -d '\r' | cut -d' ' -f1)"
  unzip -oq "$TMP/ff.zip" -d "$TMP/ff"
  for t in ffmpeg ffprobe; do
    install -m 755 "$(find "$TMP/ff" -type f -name "$t.exe" | head -1)" "$OUT/$t-$TRIPLE.exe"
  done
else
  # Static macOS builds by Martin Riedl; GitHub-hosted ffmpeg-static as a fallback.
  arch=arm64; [[ $TRIPLE == x86_64* ]] && arch=x64
  riedl=arm64; [[ $TRIPLE == x86_64* ]] && riedl=amd64
  for t in ffmpeg ffprobe; do
    if dl "https://ffmpeg.martin-riedl.de/redirect/latest/macos/$riedl/release/$t.zip" "$TMP/$t.zip"; then
      unzip -oq "$TMP/$t.zip" -d "$TMP/$t"
      install -m 755 "$(find "$TMP/$t" -type f -name "$t" | head -1)" "$OUT/$t-$TRIPLE"
    else
      echo "  Martin Riedl's server did not answer; using ffmpeg-static from GitHub."
      dl "https://github.com/eugeneware/ffmpeg-static/releases/latest/download/$t-darwin-$arch.gz" "$TMP/$t.gz"
      gunzip -c "$TMP/$t.gz" > "$OUT/$t-$TRIPLE"
      chmod 755 "$OUT/$t-$TRIPLE"
    fi
  done
  if otool -L "$OUT/ffmpeg-$TRIPLE" | grep -qE '/opt/homebrew|/usr/local/(opt|Cellar)'; then
    echo "✗ ffmpeg links to Homebrew libraries; a static build is needed."; exit 1
  fi
  xattr -c "$OUT"/* 2>/dev/null || true
fi

if [[ "${SKIP_RUN:-}" == 1 ]]; then echo "✓ Downloaded (not started: SKIP_RUN=1)"; ls -la "$OUT"; exit 0; fi
echo "→ checking they start"
first_line() { local v; v="$("$@")"; echo "  ${v%%$'\n'*}"; }
first_line "$OUT/ffmpeg-$TRIPLE$ext" -hide_banner -version
first_line "$OUT/ffprobe-$TRIPLE$ext" -hide_banner -version
first_line "$OUT/deno-$TRIPLE$ext" --version
encoders="$("$OUT/ffmpeg-$TRIPLE$ext" -hide_banner -encoders 2>/dev/null)"
for codec in libmp3lame libopus aac; do
  grep -q "$codec" <<<"$encoders" || { echo "✗ ffmpeg has no $codec encoder"; exit 1; }
done
echo "✓ Helper programs ready in $OUT"
