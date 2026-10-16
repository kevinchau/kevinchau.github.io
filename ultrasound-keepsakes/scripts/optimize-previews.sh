#!/bin/sh
set -eu

cd "$(dirname "$0")/.."
for name in prenatal-concept age-one-concept; do
  original="output/imagegen/$name.png"
  cwebp -quiet -q 80 -resize 600 0 "$original" -o "output/imagegen/$name-600.webp"
  cwebp -quiet -q 80 "$original" -o "output/imagegen/$name-full.webp"
  original_bytes=$(wc -c < "$original")
  for tier in 600 full; do
    output="output/imagegen/$name-$tier.webp"
    output_bytes=$(wc -c < "$output")
    if [ "$output_bytes" -ge "$original_bytes" ]; then
      printf 'FAIL: %s is not smaller than its original PNG fallback\n' "$output" >&2
      exit 1
    fi
    printf '%s: %s bytes (PNG fallback: %s bytes)\n' "$output" "$output_bytes" "$original_bytes"
  done
done
