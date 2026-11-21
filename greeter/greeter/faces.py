"""Find faces and say whose they are.

YuNet finds faces and five landmarks (0.2 MB, built into OpenCV). EdgeFace-S
turns each face into a 512-number fingerprint (14 MB, 0.3 GFLOPs; IJB-C 95.6,
LFW 99.78; arXiv 2308.04168). Both run through OpenCV alone, which is ported
to QNX, on the CPU. Who is known lives in db.py.
"""
from math import atan2, ceil, degrees
from pathlib import Path
import urllib.request

import cv2
import numpy as np

DETECTOR = ("face_detection_yunet_2023mar.onnx",
            "https://github.com/opencv/opencv_zoo/raw/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx")
RECOGNIZER = ("edgeface_s_gamma_05.onnx",
              "https://github.com/yakhyo/edgeface-onnx/releases/download/weights/edgeface_s_gamma_05.onnx")
SAME_PERSON = 0.45  # reference agreement and standard-size still-image matches
CONFIDENT = 0.50  # live matches must be strictly above this score
# Where the eyes, nose and mouth corners sit in a 112x112 aligned face (ArcFace template)
TEMPLATE = np.array([[38.2946, 51.6963], [73.5318, 51.5014], [56.0252, 71.7366],
                     [41.5493, 92.3655], [70.7299, 92.2041]], np.float32)


def fetch(models: Path, name: str, url: str) -> Path:
    path = models / name
    if not path.exists():
        models.mkdir(parents=True, exist_ok=True)
        print(f"downloading {name}")
        urllib.request.urlretrieve(url, path)
    return path


def landmark_alignment(face):
    points = face[4:14].reshape(5, 2).astype(np.float32)
    return cv2.estimateAffinePartial2D(points, TEMPLATE, method=cv2.LMEDS)


def reliable_alignment(face) -> bool:
    _, inliers = landmark_alignment(face)
    return inliers is not None and int(inliers.sum()) >= 4


def level_face_crop(image, face):
    """Rotate a crop about the face centre and carry the original detection box with it."""
    x, y, width, height = map(float, face[:4])
    side = ceil(2 * max(width, height))
    dx, dy = face[6:8] - face[4:6]
    center = (x + width / 2, y + height / 2)
    matrix = cv2.getRotationMatrix2D(center, degrees(atan2(dy, dx)), 1.0)
    matrix[:, 2] += (side / 2 - center[0], side / 2 - center[1])
    corners = np.float32([[[x, y], [x + width, y], [x + width, y + height], [x, y + height]]])
    mapped = cv2.transform(corners, matrix)[0]
    lower = mapped.min(axis=0)
    box = np.r_[lower, mapped.max(axis=0) - lower]
    return cv2.warpAffine(image, matrix, (side, side)), box


class Faces:
    def __init__(self, models: Path):
        self.detector = cv2.FaceDetectorYN.create(str(fetch(models, *DETECTOR)), "", (320, 320), 0.8)
        self.net = cv2.dnn.readNetFromONNX(str(fetch(models, *RECOGNIZER)))

    def find(self, img) -> np.ndarray:
        """Each row: x, y, w, h, 5 landmarks (x, y), score."""
        h, w = img.shape[:2]
        self.detector.setInputSize((w, h))
        _, found = self.detector.detect(img)
        return found if found is not None else np.zeros((0, 15), np.float32)

    def fingerprint(self, img, face) -> np.ndarray:
        m, _ = landmark_alignment(face)
        aligned = cv2.warpAffine(img, m, (112, 112))
        pooled = self._embedding(aligned) + self._embedding(cv2.flip(aligned, 1))
        return pooled / np.linalg.norm(pooled)

    def _embedding(self, aligned: np.ndarray) -> np.ndarray:
        self.net.setInput(cv2.dnn.blobFromImage(aligned, 1 / 127.5, (112, 112), (127.5, 127.5, 127.5), swapRB=True))
        f = self.net.forward().flatten()
        return f / np.linalg.norm(f)

    def main_print(self, photo):
        """Fingerprint of the main face in a photo file, or None when it has no face."""
        img = cv2.imread(str(photo))
        found = self.find(img) if img is not None else []
        if not len(found):
            return None
        return self.fingerprint(img, found[Focus().pick(found, img.shape[1], img.shape[0], 0.0)])


class Focus:
    """Picks the main face and holds it, like face-priority autofocus.

    Each face scores on size (closer), centring and facing the camera. The main
    face keeps the lock until it leaves, or until another face scores SWITCH
    times higher for HOLD seconds straight, so it never flickers between people.
    `track` goes up each time the main face becomes a different face (someone new stepped up), so the
    conversation can tell a new person from the same person whose name dipped for a moment.
    """
    SWITCH = 1.5
    HOLD = 0.3
    LOST = 1.0  # seconds the main face may vanish (a missed detection, a glance down) and still be the same face
    SAME = 0.40  # fingerprints at least this alike are the same person (others reach it about 1 time in 400)
    BLEND = 0.55  # only a frame clearly of the same person updates the running fingerprint, so it can't drift
    MISSES = 2  # frames in a row unlike the main face's fingerprint before it counts as someone else there
    PENDING = 30  # frames (about a second) to wait for a readable look at a face picked up again before deciding

    def __init__(self):
        self.box = None
        self.last = 0.0  # the main face's score on size and centring, last time it was seen
        self.challenger_since = None
        self.track = 0
        self.lost_since = None
        self.fp = None  # running fingerprint of the main face
        self.fp_track = -1
        self.misses = 0
        self.pending = False  # the main face was just picked up again: same person as before, or someone new?
        self.waited = 0

    @staticmethod
    def facing(face) -> float:
        """1 for a face looking straight at the camera, down to 0 for one turned or tilted well away."""
        (rx, ry), (lx, ly), (nx, _) = face[4:6], face[6:8], face[8:10]
        eyes = max(1.0, abs(lx - rx))
        turned = abs(nx - (rx + lx) / 2) / eyes   # nose off the eye midline: head turned
        tilted = abs(ly - ry) / eyes              # eyes not level: head tilted
        return max(0.0, 1 - 2 * turned) * max(0.0, 1 - 2 * tilted)

    @classmethod
    def score(cls, face, width, height, facing: bool = True) -> float:
        """Size (closer) and centring; with facing, also how straight on the face looks. Only the first pick
        uses facing: a head turn must never hand the lock to the friend beside them."""
        x, y, w, h = face[:4]
        size = (w * h) / (width * height)
        dx, dy = (x + w / 2) / width - 0.5, (y + h / 2) / height - 0.5
        centred = 1 - min(1.0, (dx * dx + dy * dy) ** 0.5 / 0.71)
        if not facing:
            return size * (0.5 + 0.5 * centred)
        return size * (0.5 + 0.5 * centred) * (0.5 + 0.5 * cls.facing(face))

    @staticmethod
    def overlap(a, b) -> float:
        ax, ay, aw, ah = a
        bx, by, bw, bh = b
        iw = max(0.0, min(ax + aw, bx + bw) - max(ax, bx))
        ih = max(0.0, min(ay + ah, by + bh) - max(ay, by))
        inter = iw * ih
        return inter / (aw * ah + bw * bh - inter)

    def pick(self, faces, width, height, now) -> int | None:
        """Index of the main face in `faces`, or None when there is none (no faces, or the main face missed
        a frame or two and the faces left are only the people around them)."""
        if len(faces) == 0:
            self.challenger_since = None
            self.lost_since = self.lost_since or now
            if now - self.lost_since > self.LOST:
                self.box = None
            return None
        place = [self.score(f, width, height, facing=False) for f in faces]
        current = None
        if self.box is not None:
            near = max(range(len(faces)), key=lambda i: self.overlap(self.box, faces[i][:4]))
            if self.overlap(self.box, faces[near][:4]) > 0.3:
                current = near
        if current is None:
            first = self.box is None
            if not first:
                # The main face is missing but others are here: hold its place for LOST, unless someone much
                # closer than it was has clearly stepped up.
                self.lost_since = self.lost_since or now
                biggest = max(range(len(faces)), key=place.__getitem__)
                if now - self.lost_since <= self.LOST and place[biggest] <= self.SWITCH * self.last:
                    return None
                main = biggest
                self.pending, self.waited = True, 0  # confirm() decides: them again, or someone else
            else:
                full = [self.score(f, width, height) for f in faces]
                main = max(range(len(faces)), key=full.__getitem__)
                self.pending, self.waited = True, 0  # confirm() decides if it's whoever was here before
            self.challenger_since = None
        else:
            main = current
            best = max(range(len(faces)), key=place.__getitem__)
            if best != current and place[best] > self.SWITCH * place[current]:
                self.challenger_since = self.challenger_since or now
                if now - self.challenger_since >= self.HOLD:
                    main, self.challenger_since = best, None
                    self.pending, self.waited = True, 0
            else:
                self.challenger_since = None
        self.lost_since = None
        self.last = place[main]
        self.box = tuple(faces[main][:4])
        return main

    def confirm(self, fp, front: bool = True) -> None:
        """Check the main face's fingerprint (None: too small to read) against the face being tracked.
        Someone else stepping into the same spot gets a new track, and the same person picked up again after
        a gap keeps theirs. front: the face looks at the camera; only then does an unlike fingerprint count,
        since a sharply turned head reads unlike itself."""
        sim = float(np.dot(fp, self.fp)) if fp is not None and self.fp is not None else None
        if self.pending:
            self.waited += 1
            if sim is not None and sim >= self.SAME:
                self.pending = False  # the same person again: keep their track
            elif self.fp is None or (fp is not None and front) or self.waited >= self.PENDING:
                self.pending = False
                self.track += 1
                self.fp = fp
            self.misses = 0
        elif fp is None:
            return
        elif self.fp is None or self.fp_track != self.track:
            self.fp, self.misses = fp, 0
        elif sim < self.SAME:
            if not front:
                return
            self.misses += 1
            if self.misses >= self.MISSES:
                self.track += 1
                self.fp, self.misses = fp, 0
        else:
            self.misses = 0
            if sim >= self.BLEND:
                mixed = 0.8 * self.fp + 0.2 * fp
                self.fp = mixed / (np.linalg.norm(mixed) or 1.0)
        self.fp_track = self.track
