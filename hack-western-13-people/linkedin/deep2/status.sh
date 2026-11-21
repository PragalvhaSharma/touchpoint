cd "$(dirname "$0")"
echo "claude jobs alive: $(ps aux | grep -c '[c]laude -p')"
for f in results-*.json rematch-results-*.json rematch-profiles-*.json; do [ -f "$f" ] && python3 -c "
import json
try:
  d=json.load(open('$f')); print('$f', len(d), 'added', sum(1 for x in d if x.get('added_this_pass')), 'conf', [x.get('confidence') for x in d][:0] or '')
except Exception as e: print('$f','INVALID',e)"; done
