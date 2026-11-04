#!/usr/bin/env bash
#
# Build a zip bundle that extensions.gnome.org (EGO) accepts.
# Usage: ./build.sh
#
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)

# shellcheck source=ego.conf
source "$HERE/ego.conf"

# By default the bundle is built from this directory: the repository is the
# source of truth. Only the files of the extension itself are packed, the
# development files (this script, ego.conf, UPLOAD.md, dist/, stage/) are
# excluded below.
SRC=${SRC:-$HERE}

if [[ ! -d $SRC ]]; then
    echo "Source extension not found: $SRC" >&2
    exit 1
fi

case $UUID in
    *@*) ;;
    *) echo "UUID must look like name@domain (got: $UUID)" >&2; exit 1 ;;
esac

STAGE="$HERE/stage"
DIST="$HERE/dist"
ZIP="$DIST/$UUID.shell-extension.zip"

rm -rf "$STAGE"
mkdir -p "$STAGE" "$DIST"

echo "==> Staging $SRC"
tar -C "$SRC" \
    --exclude='*.zip' \
    --exclude='.git' --exclude='.git/*' --exclude='.gitignore' \
    --exclude='build.sh' --exclude='ego.conf' \
    --exclude='nested-shell.sh' --exclude='UPLOAD.md' \
    --exclude='README.md' \
    --exclude='dist' --exclude='stage' \
    --exclude='schemas/gschemas.compiled' \
    --exclude='*.orig' --exclude='*.rej' --exclude='*~' \
    -cf - . | tar -C "$STAGE" -xf -

echo "==> Writing metadata.json"
python3 - "$STAGE/metadata.json" "$UUID" "$NAME" "$URL" <<'PY'
import json
import sys

path, uuid, name, url = sys.argv[1:5]

with open(path, encoding='utf-8') as fh:
    meta = json.load(fh)

meta['uuid'] = uuid
meta['name'] = name

url = url.strip()
if url:
    meta['url'] = url
else:
    meta.pop('url', None)

with open(path, 'w', encoding='utf-8') as fh:
    json.dump(meta, fh, indent=2, ensure_ascii=False)
    fh.write('\n')
PY

echo "==> Compiling GSettings schemas"
if ! command -v glib-compile-schemas >/dev/null; then
    echo "glib-compile-schemas is missing" >&2
    exit 1
fi
glib-compile-schemas --strict "$STAGE/schemas"

echo "==> Packing"
rm -f "$ZIP"
python3 - "$STAGE" "$ZIP" <<'PY'
import os
import sys
import zipfile

stage, out = sys.argv[1:3]

# The timestamps are fixed so that building the same sources twice gives the
# same archive, and therefore the same SHA256.
STAMP = (1980, 1, 1, 0, 0, 0)

with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as zf:
    for root, dirs, files in os.walk(stage):
        dirs.sort()
        for name in sorted(files):
            path = os.path.join(root, name)
            info = zipfile.ZipInfo(os.path.relpath(path, stage),
                date_time=STAMP)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            with open(path, 'rb') as fh:
                zf.writestr(info, fh.read())
PY

echo "==> Verifying"
python3 - "$ZIP" "$UUID" <<'PY'
import json
import sys
import zipfile

zip_path, uuid = sys.argv[1:3]

with zipfile.ZipFile(zip_path) as zf:
    names = set(zf.namelist())
    bad = zf.testzip()
    if bad:
        raise SystemExit(f'Corrupt entry: {bad}')

    required = [
        'metadata.json', 'extension.js', 'prefs.js', 'magnification.js',
        'folder.js', 'stylesheet.css',
        'schemas/gschemas.compiled',
        'schemas/org.gnome.shell.extensions.dash-to-dock-magnify.gschema.xml',
    ]
    missing = [p for p in required if p not in names]
    if missing:
        raise SystemExit(f'Missing files in zip: {missing}')

    nested = [n for n in names if n.startswith(uuid + '/')]
    if nested:
        raise SystemExit('Zip must not contain a top-level directory')

    meta = json.loads(zf.read('metadata.json'))
    assert meta['uuid'] == uuid, f"metadata uuid {meta['uuid']} != {uuid}"
    for key in ('name', 'description', 'shell-version'):
        assert meta.get(key), f'metadata is missing {key}'

    mo = [n for n in names if n.endswith('.mo')]
    print(f'    metadata uuid : {meta["uuid"]}')
    print(f'    name          : {meta["name"]}')
    print(f'    shell-version : {", ".join(meta["shell-version"])}')
    print(f'    files         : {len(names)} ({len(mo)} translations)')
PY

SIZE=$(du -h "$ZIP" | cut -f1)
SHA=$(sha256sum "$ZIP" | cut -d' ' -f1)

echo
echo "Bundle : $ZIP"
echo "Size   : $SIZE"
echo "SHA256 : $SHA"
echo
echo "Upload at https://extensions.gnome.org/upload/"
