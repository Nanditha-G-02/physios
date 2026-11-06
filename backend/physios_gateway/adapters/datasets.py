"""Read-only access to LeRobot dataset folders on the host (the same folders the recorder
writes, mounted into the container as /root/.cache/huggingface/lerobot).

* resolve ``<owner>/<name>`` to a folder under one of the configured roots
* serve files with HTTP Range (video seeking)
* stream a .tar.gz export of one dataset
Nothing here writes to a dataset.
"""

import mimetypes
import os
from pathlib import Path
import re
import tarfile

from physios_gateway.errors import ApiError, not_found

ID_RE = re.compile(r'^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$')
mimetypes.add_type('video/mp4', '.mp4')
mimetypes.add_type('application/vnd.apache.parquet', '.parquet')
mimetypes.add_type('application/x-ndjson', '.jsonl')


class Datasets:

    def __init__(self, roots):
        self.roots = [Path(r) for r in roots]

    def resolve(self, dataset_id):
        if not isinstance(dataset_id, str) or not ID_RE.match(dataset_id) or '..' in dataset_id:
            raise ApiError(400, 'bad_dataset_id', 'Dataset id must look like owner/name.')
        for root in self.roots:
            p = (root / dataset_id).resolve()
            if p.is_dir() and _inside(p, root):
                return p
        raise not_found('Dataset %s is not in any dataset folder (%s).' % (
            dataset_id, ', '.join(str(r) for r in self.roots)))

    def file(self, dataset_id, rel):
        base = self.resolve(dataset_id)
        if not rel or rel.startswith('/') or '\\' in rel or any(
                part in ('..', '') for part in rel.split('/')):
            raise ApiError(400, 'bad_path', 'Invalid file path.')
        p = (base / rel).resolve()
        if not _inside(p, base) or not p.is_file():
            raise not_found('No file %s in %s.' % (rel, dataset_id))
        return p

    def summary(self):
        out = []
        for root in self.roots:
            entry = {'path': str(root), 'exists': root.is_dir(), 'datasets': 0}
            if root.is_dir():
                try:
                    for owner in root.iterdir():
                        if owner.is_dir():
                            entry['datasets'] += sum(
                                1 for d in owner.iterdir()
                                if (d / 'meta' / 'info.json').is_file())
                except OSError:
                    pass
            out.append(entry)
        return out

    def export_stream(self, dataset_id, wfile):
        """Write a gzip tar of the dataset to ``wfile`` (streamed, read-only)."""
        base = self.resolve(dataset_id)
        with tarfile.open(fileobj=wfile, mode='w|gz') as tar:
            for dirpath, dirnames, filenames in os.walk(base, followlinks=False):
                dirnames.sort()
                for fn in sorted(filenames):
                    p = Path(dirpath) / fn
                    if p.is_symlink():
                        continue
                    tar.add(str(p), arcname=str(Path(base.name) / p.relative_to(base)),
                            recursive=False)


def _inside(p, root):
    try:
        p.relative_to(root.resolve())
        return True
    except ValueError:
        return False


def parse_range(header, size):
    """``bytes=a-b`` -> (start, end) inclusive, or None for the whole file. Raises on 416."""
    if not header or not header.startswith('bytes='):
        return None
    spec = header[6:].split(',')[0].strip()
    a, _, b = spec.partition('-')
    try:
        if a == '':
            n = int(b)
            start, end = max(0, size - n), size - 1
        else:
            start = int(a)
            end = int(b) if b else size - 1
    except ValueError:
        return None
    if start >= size or start > end:
        raise ApiError(416, 'range_not_satisfiable', 'Requested range is outside the file.')
    return start, min(end, size - 1)


def content_type(path):
    return mimetypes.guess_type(str(path))[0] or 'application/octet-stream'
