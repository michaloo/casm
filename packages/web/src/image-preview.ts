import { createContext } from "react";
import type { ImageData } from "@casm/protocol";

// `image` keeps a transcript image's Blob alive while the preview shows it.
export type PreviewImage = { src: string; name: string; image?: ImageData };
export type ImageSelection = { images: PreviewImage[]; index: number };
export const ImagePreviewContext = createContext<((selection: ImageSelection) => void) | undefined>(undefined);
const shown = /^image\/(png|jpeg|gif|webp|avif)$/i;
// Transcript images arrive as base64 strings; a long session holds hundreds
// of them. They are kept as Blobs instead (outside the JS heap, a quarter
// smaller), shown through blob URLs that are revoked once the Blob is
// collected with the transcript items that held it.
const blobs = new WeakMap<ImageData, Blob>();
const urls = new WeakMap<Blob, string>();
const revoke = typeof FinalizationRegistry === "function" ? new FinalizationRegistry<string>((url) => URL.revokeObjectURL(url)) : undefined;
function decode(data: string): Uint8Array<ArrayBuffer> {
  const fromBase64 = (Uint8Array as unknown as { fromBase64?: (s: string) => Uint8Array<ArrayBuffer> }).fromBase64;
  if (fromBase64) return fromBase64(data);
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
// The same image with its data moved into a Blob (images that cannot be shown
// lose their data, which nothing reads).
export function holdImage(image: ImageData): ImageData {
  if (!image.data || typeof Blob !== "function" || typeof URL.createObjectURL !== "function") return image;
  if (!shown.test(image.mediaType) || !/^[A-Za-z0-9+/]*={0,2}$/.test(image.data)) return { mediaType: image.mediaType };
  let bytes: Uint8Array<ArrayBuffer>;
  try { bytes = decode(image.data); } catch { return { mediaType: image.mediaType }; }
  const held = { mediaType: image.mediaType };
  blobs.set(held, new Blob([bytes], { type: image.mediaType }));
  return held;
}
export function imageSource(image: ImageData): string | undefined {
  const blob = blobs.get(image);
  if (blob) {
    let url = urls.get(blob);
    if (!url) {
      url = URL.createObjectURL(blob);
      urls.set(blob, url);
      revoke?.register(blob, url);
    }
    return url;
  }
  return image.data && shown.test(image.mediaType) && /^[A-Za-z0-9+/]*={0,2}$/.test(image.data)
    ? `data:${image.mediaType};base64,${image.data}` : undefined;
}
export function withoutImagePlaceholders(text: string) {
  return text.split("\n").filter(line => !/^\s*\[(?:image|Image: source: [^\r\n]*)\]\s*$/i.test(line)).join("\n").trim();
}
