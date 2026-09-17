#!/usr/bin/env bash
set -euo pipefail

readonly nemo_version="0.1.0"
readonly nemo_archive="nemo-speech-${nemo_version}-linux-x86_64-cpu.tar.gz"
readonly nemo_archive_sha256="0f74131d631ad2c694cf0ec53490866bb6461147959589a69fb6fc231944065b"
readonly nemo_archive_url="https://github.com/NVIDIA/NeMo-Speech.cpp/releases/download/v${nemo_version}/${nemo_archive}"
readonly model_revision="541d1f99c6b0c3cd0b11a95167540bb8edefd82b"
readonly model_filename="parakeet-tdt-0.6b-v3.q8_0.gguf"
readonly model_sha256="e3880d0aaaaf2c308ea2c35016b2b895c423eb3fda924c1b463d1c19b7f4d32e"
readonly model_size="713975456"
readonly model_url="https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3/resolve/${model_revision}/${model_filename}?download=true"

hermes_home="${HERMES_HOME:-$HOME/.hermes}"
runtime_dir="$hermes_home/tools/nemo-speech/$nemo_version"
runtime_bin="$runtime_dir/bin/nemo-speech"
runtime_marker="$runtime_dir/.archive-sha256"
model_dir="$hermes_home/models/parakeet-tdt-0.6b-v3"
model_path="$model_dir/$model_filename"
mode="${1:-install}"

fail() {
  printf 'Parakeet provisioning failed: %s\n' "$*" >&2
  exit 1
}

actual_sha256() {
  sha256sum "$1" | awk '{print $1}'
}

verify_runtime() {
  [ -x "$runtime_bin" ] || return 1
  [ -f "$runtime_marker" ] || return 1
  [ "$(tr -d '[:space:]' < "$runtime_marker")" = "$nemo_archive_sha256" ] || return 1
  [ "$("$runtime_bin" --version 2>/dev/null)" = "nemo-speech $nemo_version" ] || return 1
}

verify_model() {
  [ -f "$model_path" ] || return 1
  [ "$(wc -c < "$model_path" | tr -d '[:space:]')" = "$model_size" ] || return 1
  [ "$(actual_sha256 "$model_path")" = "$model_sha256" ] || return 1
}

case "$mode" in
  install|--verify-only) ;;
  *) fail "usage: $0 [--verify-only]" ;;
esac

[ "$(uname -s)" = "Linux" ] || fail "NeMo-Speech.cpp is pinned for Linux on this host"
case "$(uname -m)" in
  x86_64|amd64) ;;
  *) fail "the pinned CPU runtime requires an x86-64 host" ;;
esac
command -v sha256sum >/dev/null 2>&1 || fail "sha256sum is required"

if [ "$mode" = "--verify-only" ]; then
  verify_runtime || fail "NeMo-Speech.cpp $nemo_version is missing or invalid at $runtime_dir"
  printf 'ok   NeMo-Speech.cpp runtime: %s\n' "$nemo_version"
  verify_model || fail "Parakeet Q8 model is missing or invalid at $model_path"
  printf 'ok   Parakeet model: %s (%s bytes)\n' "$model_filename" "$model_size"
  exit 0
fi

command -v curl >/dev/null 2>&1 || fail "curl is required"
command -v tar >/dev/null 2>&1 || fail "tar is required"

download_dir="$(mktemp -d "${TMPDIR:-/tmp}/parakeet-provision.XXXXXX")"
trap 'rm -rf -- "$download_dir"' EXIT

if verify_runtime; then
  printf 'NeMo-Speech.cpp %s is already installed.\n' "$nemo_version"
else
  runtime_archive="$download_dir/$nemo_archive"
  printf 'Downloading NeMo-Speech.cpp %s CPU runtime...\n' "$nemo_version"
  curl --fail --location --silent --show-error --retry 3 \
    --proto '=https' --tlsv1.2 \
    --output "$runtime_archive" "$nemo_archive_url"
  [ "$(actual_sha256 "$runtime_archive")" = "$nemo_archive_sha256" ] \
    || fail "NeMo-Speech.cpp archive checksum mismatch"
  install -d -m 700 "$runtime_dir"
  tar -xzf "$runtime_archive" -C "$runtime_dir" --strip-components=1
  printf '%s\n' "$nemo_archive_sha256" > "$runtime_marker"
  verify_runtime || fail "installed NeMo-Speech.cpp runtime did not pass verification"
  printf 'Installed NeMo-Speech.cpp %s at %s.\n' "$nemo_version" "$runtime_dir"
fi

if verify_model; then
  printf 'Parakeet Q8 model is already installed.\n'
else
  install -d -m 700 "$model_dir"
  model_download="$model_path.download"
  printf 'Downloading Parakeet TDT 0.6B v3 Q8 model (713,975,456 bytes)...\n'
  if [ -f "$model_download" ] \
    && [ "$(wc -c < "$model_download" | tr -d '[:space:]')" -ge "$model_size" ]; then
    rm -f "$model_download"
  fi
  curl --fail --location --silent --show-error --retry 3 \
    --proto '=https' --tlsv1.2 --continue-at - \
    --output "$model_download" "$model_url"
  if [ "$(wc -c < "$model_download" | tr -d '[:space:]')" != "$model_size" ]; then
    rm -f "$model_download"
    fail "Parakeet model size mismatch"
  fi
  if [ "$(actual_sha256 "$model_download")" != "$model_sha256" ]; then
    rm -f "$model_download"
    fail "Parakeet model checksum mismatch"
  fi
  chmod 600 "$model_download"
  mv -f "$model_download" "$model_path"
  printf 'Installed Parakeet Q8 model at %s.\n' "$model_path"
fi

printf '%s\n' 'Parakeet STT provisioning is complete.'
