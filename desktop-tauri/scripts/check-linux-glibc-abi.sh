#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "usage: $(basename "$0") --max <glibc-version> <AppImage|deb>..." >&2
}

die() {
  echo "check-linux-glibc-abi: $*" >&2
  exit 1
}

max=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --max)
      [ "$#" -ge 2 ] || { usage; exit 2; }
      max="$2"
      shift 2
      ;;
    --) shift; break ;;
    -*) usage; exit 2 ;;
    *) break ;;
  esac
done

[ -n "$max" ] && [ "$#" -gt 0 ] || { usage; exit 2; }
[[ "$max" =~ ^[0-9]+(\.[0-9]+)+$ ]] || die "invalid --max value: $max"

for artifact in "$@"; do
  [ -f "$artifact" ] || die "no such artifact: $artifact"
  case "$artifact" in
    *.AppImage|*.deb) ;;
    *) die "unsupported artifact type: $artifact (expected .AppImage or .deb)" ;;
  esac
done

command -v readelf >/dev/null 2>&1 || die "required tool not found: readelf (install binutils)"

version_gt() {
  [ "$1" != "$2" ] || return 1
  [ "$(printf '%s\n%s\n' "$1" "$2" | LC_ALL=C sort -V | tail -n 1)" = "$1" ]
}

elf_versions() {
  local file="$1" output status=0
  output="$(readelf --version-info --wide "$file" 2>&1)" || status=$?
  if [ "$status" -ne 0 ]; then
    case "$output" in
      *"No version information found"*) ;;
      *)
        echo "::error::cannot read ELF version information: $file" >&2
        return 1
        ;;
    esac
  fi
  printf '%s\n' "$output" | awk '
    /Version needs section/ { needs = 1; next }
    /Version (definition|symbols) section/ { needs = 0; next }
    needs && /Name: GLIBC_/ {
      for (i = 1; i <= NF; i++)
        if ($i ~ /^GLIBC_[0-9]+(\.[0-9]+)+$/) print $i
    }
  ' | sed 's/^GLIBC_//' | LC_ALL=C sort -V -u
}

is_elf() {
  [ "$(head -c 4 "$1" 2>/dev/null | od -An -tx1 | tr -d ' \n')" = "7f454c46" ]
}

violations=0
extract_failures=0
elf_count=0
versioned_count=0

check_elf() {
  local file="$1" label="$2" versions file_max
  CHECK_MAX=""
  is_elf "$file" || return 0
  elf_count=$((elf_count + 1))
  versions="$(elf_versions "$file")"
  [ -n "$versions" ] || return 0
  versioned_count=$((versioned_count + 1))
  file_max="$(printf '%s\n' "$versions" | tail -n 1)"
  CHECK_MAX="$file_max"
  if version_gt "$file_max" "$max"; then
    violations=$((violations + 1))
    echo "::error::${label}: requires GLIBC_${file_max} (> ${max}); required versions: $(printf '%s' "$versions" | tr '\n' ' ')"
  fi
}

scan_elf_tree() {
  local root="$1" kind="$2" list file rel tree_elf=0 tree_high=""
  [ -d "$root" ] || die "extracted ${kind} tree is missing: $root"
  list="$(mktemp -p "$work")"
  if ! find "$root" -type f -print0 > "$list"; then
    echo "::error::cannot enumerate files under ${kind}: $root" >&2
    extract_failures=$((extract_failures + 1))
    rm -f "$list"
    return 0
  fi
  while IFS= read -r -d '' file; do
    rel="${file#"$root"/}"
    check_elf "$file" "${kind}/${rel}"
    [ -n "$CHECK_MAX" ] || continue
    tree_elf=$((tree_elf + 1))
    if [ -z "$tree_high" ] || version_gt "$CHECK_MAX" "$tree_high"; then
      tree_high="$CHECK_MAX"
    fi
  done < "$list"
  rm -f "$list"
  echo "scanned ${tree_elf} ELF files with GLIBC requirements under ${kind}; highest: ${tree_high:-none} (limit ${max})"
}

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
index=0

for artifact in "$@"; do
  artifact="$(cd "$(dirname "$artifact")" && pwd)/$(basename "$artifact")"
  index=$((index + 1))

  case "$artifact" in
    *.AppImage)
      elf_count=$((elf_count + 1))
      runtime_versions="$(elf_versions "$artifact")"
      if [ -n "$runtime_versions" ]; then
        versioned_count=$((versioned_count + 1))
        runtime_max="$(printf '%s\n' "$runtime_versions" | tail -n 1)"
        echo "AppImage runtime ${artifact}: highest GLIBC requirement GLIBC_${runtime_max} (limit ${max})"
        if version_gt "$runtime_max" "$max"; then
          violations=$((violations + 1))
          echo "::error::${artifact} (AppImage runtime): requires GLIBC_${runtime_max} (> ${max}); required versions: $(printf '%s' "$runtime_versions" | tr '\n' ' ')"
        fi
      else
        echo "AppImage runtime ${artifact}: no GLIBC version requirement"
      fi

      extract="$work/extract-$index"
      mkdir -p "$extract"
      if ! ( cd "$extract" && "$artifact" --appimage-extract >/dev/null 2>&1 ); then
        echo "::error::${artifact}: embedded AppImage runtime did not extract the payload"
        extract_failures=$((extract_failures + 1))
        continue
      fi
      scan_elf_tree "$extract/squashfs-root" "AppImage $(basename "$artifact")"
      ;;
    *.deb)
      command -v dpkg-deb >/dev/null 2>&1 || die "required tool not found: dpkg-deb (install dpkg)"
      target="$work/deb-$index"
      if ! dpkg-deb -x "$artifact" "$target"; then
        echo "::error::${artifact}: dpkg-deb failed to extract the package"
        extract_failures=$((extract_failures + 1))
        continue
      fi
      scan_elf_tree "$target" "deb $(basename "$artifact")"
      ;;
  esac
done

[ "$elf_count" -gt 0 ] || die "no ELF file was found in the supplied artifacts"
[ "$versioned_count" -gt 0 ] || die "no ELF file declares a GLIBC version requirement; refusing to pass a vacuous check"

if [ "$violations" -gt 0 ] || [ "$extract_failures" -gt 0 ]; then
  echo "::error::glibc ABI check failed: ${violations} violating ELF file(s), ${extract_failures} artifact extraction failure(s), limit ${max}" >&2
  exit 1
fi

echo "glibc ABI check passed: ${elf_count} ELF files (${versioned_count} with GLIBC requirements), limit ${max}"
