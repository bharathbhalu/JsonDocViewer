#!/bin/sh
# 3D Model regression suite. Run after every change to public/model or
# model-build. The checks live in shape.test.mjs. The run is done only
# when it prints "0 failed".
set -e
cd "$(dirname "$0")/.."
./build.sh
node test/shape.test.mjs
