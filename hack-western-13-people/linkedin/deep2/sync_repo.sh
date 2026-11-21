#!/bin/bash
# Rebuild locally, sync research outputs into the repo copy, compress photos, rebuild, commit, push.
# Usage: sync_repo.sh "commit message to Akshay"
set -euo pipefail
L="/Users/prag/Documents/PragPersonal/Projects/at-Western/outputs/hack-western-13-slack"
R="/Users/prag/Documents/PragPersonal/Projects/at-Western/at Western"
H="$R/hack-western-13-people"
MSG="${1:-Hack Western people: more public profile data}"
cd "$L"
python3 linkedin/deep2/merge.py >/dev/null
python3 linkedin/export.py >/dev/null; python3 gallery.py >/dev/null; python3 linkedin/export_profiles.py >/dev/null
cd "$R"
git pull --rebase --autostash -q
cp "$L/gallery.py" "$H/gallery.py"
cp "$L/scrub.py" "$H/scrub.py"
cp "$L/linkedin/export.py" "$L/linkedin/export_profiles.py" "$L/linkedin/fetch_li_crawler.py" "$L/linkedin/li_public.py" "$L/linkedin/fetch_tf_photos.py" "$H/linkedin/"
mkdir -p "$H/linkedin/li-public" && rsync -a --delete "$L/linkedin/li-public/" "$H/linkedin/li-public/"
cp "$L/linkedin/overrides.json" "$L/linkedin/fallback-photos.json" "$L/linkedin/fallback-rejected.json" "$L/linkedin/fetch-pending.json" "$L/linkedin/fetched.json" "$L/linkedin/photo-rejects.json" "$H/linkedin/"
mkdir -p "$H/photos-fallback" "$H/photos-linkedin"
rsync -a "$L/photos-fallback/" "$H/photos-fallback/"
# only LinkedIn photos the repo doesn't have yet (by stem; repo copies are compressed .jpg)
for f in "$L"/photos-linkedin/*; do b=$(basename "$f"); s="${b%.*}"; [ -e "$H/photos-linkedin/$s.jpg" ] && [ "$f" -ot "$H/photos-linkedin/$s.jpg" ] || cp "$f" "$H/photos-linkedin/$b"; done
cp "$L"/linkedin/enrich/results/zz-zz-zz-deep2-chunk-*.json "$H/linkedin/enrich/results/"
mkdir -p "$H/linkedin/deep2" && rsync -a --exclude 'work-*' "$L/linkedin/deep2/" "$H/linkedin/deep2/"
mkdir -p "$H/linkedin/photo-hunt" && cp "$L"/linkedin/photo-hunt/results*.json "$H/linkedin/photo-hunt/" 2>/dev/null || true
cd "$H"
python3 compress_photos.py
python3 linkedin/export.py >/dev/null; python3 gallery.py; python3 linkedin/export_profiles.py
python3 - <<'PY'
import re,os
H="/Users/prag/Documents/PragPersonal/Projects/at-Western/at Western/hack-western-13-people"
s=open(H+'/photo-gallery.html').read()
src=set(re.findall(r'src="([^"]+)"',s)); miss=[x for x in src if not x.startswith(('http','data:')) and not os.path.exists(os.path.join(H,x))]
print('local srcs',len(src),'missing',len(miss),miss[:5])
assert not miss
PY
cd "$R"
git add -A hack-western-13-people
git diff --cached --stat | tail -3
git commit -q -m "$MSG"
for i in 1 2 3; do git push -q && break || git pull --rebase --autostash -q; done
git log --oneline -1
