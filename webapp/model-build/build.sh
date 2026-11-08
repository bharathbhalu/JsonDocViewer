#!/bin/sh
# Build the 3D Model worker into public/model/vendor.
# OpenCascade and Three.js are shared files (symlinked from the add-on
# install under public/cad/vendor) so this folder can stand on its own
# once those two files are copied here.
set -e
cd "$(dirname "$0")"
mkdir -p ../public/model/vendor
ln -sfn ../../cad/vendor/replicad_single.wasm ../public/model/vendor/replicad_single.wasm
ln -sfn ../../cad/vendor/manifold.wasm ../public/model/vendor/manifold.wasm
ln -sfn ../../cad/vendor/three-bundle.js ../public/model/vendor/three-bundle.js
ln -sfn ../cad-build/node_modules node_modules
../cad-build/node_modules/.bin/esbuild worker.src.js \
  --bundle --format=esm --target=es2020,safari15 --minify \
  --external:node:* \
  --outfile=../public/model/vendor/model-worker.js
