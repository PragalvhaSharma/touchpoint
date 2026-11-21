"""Replay the paired benchmark with the greeter environment and two local checkouts.

python portrait_review.py --baseline /path/to/f741a30 --candidate /path/to/research-branch \
    --models /path/to/greeter/models --output /tmp/portrait-results.json

Each database is fresh. Only aggregate counts, input checksums and method metadata
are written. The immutable split is stored in portrait_review_split.json.
"""
import argparse
from collections import Counter
import csv
import hashlib
import json
from pathlib import Path
import subprocess
import sys
from tempfile import TemporaryDirectory

PROTOCOLS = ('historical_source_holdout', 'independent_photo_holdout', 'rechecked_source_holdout')
ARMS = ('baseline', 'withdrawals_only', 'updated')
SPLIT = Path(__file__).with_name('portrait_review_split.json')


def path_key(data, photo):
    return hashlib.sha256(photo.relative_to(data).as_posix().encode()).hexdigest()


def digest(rows):
    data = json.dumps(rows, separators=(',', ':'), ensure_ascii=True).encode()
    return hashlib.sha256(data).hexdigest()


def read_csv(file):
    with file.open(newline='') as stream:
        return list(csv.DictReader(stream))


def evaluate(root, models, arm, protocol):
    # Use the actual install from this arm; workers run in separate processes.
    import cv2
    import numpy as np
    sys.path.insert(0, str(root / 'greeter'))
    from greeter import main as app, roster

    cv2.setNumThreads(1)
    data = root / 'hack-western-13-people'
    split = json.loads(SPLIT.read_text())
    for name, expected in split['model_sha256'].items():
        if hashlib.sha256((models / name).read_bytes()).hexdigest() != expected:
            raise ValueError(f'Model differs from the saved benchmark: {name}')
    probes = roster.held_out(data)
    inputs = [(pid, path_key(data, src), hashlib.sha256(src.read_bytes()).hexdigest())
              for pid, src in probes]
    if digest(inputs) != split['ordered_probe_sha256']:
        raise ValueError('The ordered probe IDs, paths or image bytes differ from the saved split.')
    withheld = {file_hash for _, file_hash, _ in inputs}
    withheld.update(split['historical_excluded_reference_path_hashes'])
    manifest = data / 'faces' / 'verified-portraits.csv'
    new_sources = {data / row['Photo']: row for row in read_csv(manifest)} if manifest.exists() else {}
    if (arm == 'baseline' and new_sources) or (arm != 'baseline' and len(new_sources) != 35):
        raise ValueError('Expected the pre-update checkout followed by the 35-portrait update.')

    # Start from the deployed enrollment, including current ordering, retirements and derivatives.
    with TemporaryDirectory() as empty_local_roster:
        gallery = roster.load(Path(empty_local_roster), data)
    if protocol in ('historical_source_holdout', 'rechecked_source_holdout'):
        eligible = {person.id: person for person in roster.from_hack_western(data, with_linkedin=False)}
        roster.add_faces(data, eligible)
        for sheet in (data / 'faces').glob('*.csv'):
            for row in read_csv(sheet):
                if row['Photo'] and 'linkedin' in row['Source'].casefold():
                    withheld.add(path_key(data, data / row['Photo']))
        for person in gallery.values():
            allowed = set(eligible[person.id].photos) if person.id in eligible else set()
            person.photos = [p for p in person.photos if p in allowed]
    if protocol != 'historical_source_holdout':
        withheld.update(split['additional_full_gallery_copy_path_hashes'])

    for person in gallery.values():
        person.photos = [p for p in person.photos if path_key(data, p) not in withheld
                         and not (arm == 'withdrawals_only' and p in new_sources)]
        remaining = set(person.photos)
        person.variants = {v: source for v, source in person.variants.items() if source in remaining}

    booth = object.__new__(app.Greeter)
    booth.faces = app.Faces(models)
    booth.db = app.FaceDB(':memory:')
    booth.db.sync(gallery.values(), booth.faces)
    active = {(pid, Path(photo)) for pid, photo in
              booth.db.db.execute('SELECT person_id, photo FROM faces WHERE ok = 1')}
    enrolled = {pid for pid, _ in active}
    originals = {(p.id, path) for p in gallery.values() for path in p.photos}
    edits = {(p.id, path) for p in gallery.values() for path in p.variants}
    added = {(row['Person ID'], path) for path, row in new_sources.items()}
    added_edits = {(pid, edit) for pid, path in added for edit in roster.lighting_paths(data, pid, path)}
    gallery_sets = {'originals': originals, 'lighting_edits': edits,
                    'verified_originals': originals & added, 'verified_edits': edits & added_edits}
    accounting = {k: {'eligible': len(refs), 'active': len(refs & active)} for k, refs in gallery_sets.items()}
    accounting['enrolled_ids'] = len(enrolled)
    predictions = []
    ambiguous = set(split['ambiguous_probe_path_hashes'])
    validated = set(split['current_top_card_probe_path_hashes'])
    for (pid, photo), (_, key, _) in zip(probes, inputs):
        frame = cv2.imdecode(np.frombuffer(photo.read_bytes(), np.uint8), cv2.IMREAD_COLOR)
        scale = 1280 / max(frame.shape[:2])
        if scale < 1:
            frame = cv2.resize(frame, None, fx=scale, fy=scale)
        found = booth.faces.find(frame)
        index = app.Focus().pick(found, frame.shape[1], frame.shape[0], 0)
        matches = booth.name_all(frame, found)
        predictions.append({'target': pid, 'pred': matches[index][0] if index is not None else None,
                            'enrolled': pid in enrolled, 'clean': key not in ambiguous and len(found) <= 1,
                            'validated': key in validated})
    booth.db.db.close()
    return {'predictions': predictions, 'accounting': accounting}


def outcome(row):
    if row['pred'] is None:
        return 'unnamed'
    return 'correct' if row['target'] == row['pred'] else 'wrong'


def summarize(data):
    rows = {arm: run['predictions'] for arm, run in data.items()}
    baseline = rows['baseline']
    groups = {'all': list(range(len(baseline))),
              'historical_clean': [i for i,r in enumerate(baseline) if r['clean']],
              'clean_baseline_enrolled': [i for i,r in enumerate(baseline) if r['clean'] and r['enrolled']],
              'clean_baseline_unenrolled': [i for i,r in enumerate(baseline) if r['clean'] and not r['enrolled']],
              'current_top_card_labels': [i for i,r in enumerate(baseline) if r['validated']],
              'current_top_card_and_clean': [i for i,r in enumerate(baseline) if r['validated'] and r['clean']]}
    reviewed_ids = set(json.loads(SPLIT.read_text())['reviewed_probe_person_hashes'])
    groups['reviewed_targets'] = [i for i, row in enumerate(baseline)
                                  if hashlib.sha256(row['target'].encode()).hexdigest() in reviewed_ids]
    result = {}
    for group, indexes in groups.items():
        section = {'probes': len(indexes)}
        for arm in ARMS:
            counts = Counter(outcome(rows[arm][i]) for i in indexes)
            section[arm] = {key: counts[key] for key in ('correct','wrong','unnamed')}
        for before, after, label in [('baseline', 'updated', 'paired'),
                                     ('withdrawals_only', 'updated', 'verified_additions_paired')]:
            transitions = Counter()
            new_wrong = removed_wrong = changed_wrong = 0
            for i in indexes:
                old = rows[before][i]
                new = rows[after][i]
                old_out, new_out = outcome(old), outcome(new)
                transitions[f'{old_out}_to_{new_out}'] += 1
                if old_out != 'wrong' and new_out == 'wrong':
                    new_wrong += 1
                if old_out == 'wrong' and new_out != 'wrong':
                    removed_wrong += 1
                if old_out == new_out == 'wrong' and old['pred'] != new['pred']:
                    changed_wrong += 1
            section[label] = {'new_wrong': new_wrong, 'removed_wrong': removed_wrong,
                              'changed_wrong_identity': changed_wrong, 'transitions': dict(transitions)}
        result[group] = section
    return {'groups': result, 'reference_counts': {arm: data[arm]['accounting'] for arm in ARMS}}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--baseline', type=Path, required=True)
    parser.add_argument('--candidate', type=Path, required=True)
    parser.add_argument('--models', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--worker', nargs=2, metavar=('ARM','PROTOCOL'), help=argparse.SUPPRESS)
    args = parser.parse_args()
    if args.worker:
        arm, protocol = args.worker
        if arm not in ARMS or protocol not in PROTOCOLS:
            parser.error('Unknown worker arm or protocol')
        root = args.baseline if arm == 'baseline' else args.candidate
        args.output.write_text(json.dumps(evaluate(root.resolve(), args.models.resolve(), arm, protocol)))
        return
    sections = {}
    with TemporaryDirectory() as temp:
        for protocol in PROTOCOLS:
            runs = {}
            for arm in ARMS:
                part = Path(temp) / 'rows.json'
                subprocess.run([sys.executable, str(Path(__file__).resolve()), '--worker', arm, protocol,
                                '--baseline', str(args.baseline), '--candidate', str(args.candidate),
                                '--models', str(args.models), '--output', str(part)],check=True)
                runs[arm] = json.loads(part.read_text())
            sections[protocol] = summarize(runs)
    args.output.write_text(json.dumps(sections, indent=2) + '\n')


if __name__ == '__main__':
    main()
