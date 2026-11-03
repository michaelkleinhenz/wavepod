// Thumbnails of project images (episode cover, chapter images) as data URLs, cached by path.
import { api } from './store';

const cache = new Map<string, Promise<string | null>>();

function toDataUrl(bytes: Uint8Array): string | null {
  const png = bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8;
  if (!png && !jpeg) return null;
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:${png ? 'image/png' : 'image/jpeg'};base64,${btoa(bin)}`;
}

/** Data URL of an image in the project folder, or null if it can't be read. */
export function imageUrl(rel: string): Promise<string | null> {
  let p = cache.get(rel);
  if (!p) {
    p = api()
      .readFile(rel)
      .then(toDataUrl)
      .catch(() => null);
    cache.set(rel, p);
  }
  return p;
}

/** An <img> that fills in once the file is read; shows a "missing" state if it can't be. */
export function thumbnail(rel: string, className: string): HTMLImageElement {
  const img = document.createElement('img');
  img.className = className;
  img.alt = '';
  void imageUrl(rel).then((url) => {
    if (url) img.src = url;
    else {
      img.classList.add('missing');
      img.title = `Missing image: ${rel}`;
    }
  });
  return img;
}
