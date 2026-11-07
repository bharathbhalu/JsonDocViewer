#!/bin/sh
# Rebuild the vendored CAD bundles into ../public/cad/vendor.
set -e
cd "$(dirname "$0")"
echo "Installing packages (npm)…"
npm install --no-audit --no-fund
OUT=../public/cad/vendor
rm -rf "$OUT.tmp" && mkdir -p "$OUT.tmp"
echo "Bundling…"
npx esbuild worker.src.js --bundle --format=esm --target=es2020,safari15 --minify --external:node:* --outfile="$OUT.tmp/cad-worker.js"
npx esbuild three.src.js  --bundle --format=esm --target=es2020,safari15 --minify --outfile="$OUT.tmp/three-bundle.js"
cp node_modules/replicad-opencascadejs/dist/replicad_single.wasm node_modules/manifold-3d/manifold.wasm "$OUT.tmp/"
{
  echo "Vendored CAD libraries (built by cad-build/build.sh)"; echo
  for p in replicad replicad-opencascadejs manifold-3d three fflate; do
    echo "== $p $(node -p "require('./node_modules/$p/package.json').version") ($(node -p "require('./node_modules/$p/package.json').license"))"
    cat node_modules/$p/LICENSE; echo
  done
} > "$OUT.tmp/LICENSES.txt"
node -e "const v=p=>require('./node_modules/'+p+'/package.json').version;console.log(JSON.stringify({replicad:v('replicad'),opencascade:v('replicad-opencascadejs'),manifold:v('manifold-3d'),three:v('three'),installed:new Date().toISOString()}))" > "$OUT.tmp/VERSION.json"
# Swap in atomically so a failed build never leaves a half-installed add-on.
rm -rf "$OUT" && mv "$OUT.tmp" "$OUT"
echo "Done: 3D modeling is installed."
