import { createContext } from "react";
import type { ImageData } from "@casm/protocol";

export type PreviewImage = { src: string; name: string };
export type ImageSelection = { images: PreviewImage[]; index: number };
export const ImagePreviewContext = createContext<((selection: ImageSelection) => void) | undefined>(undefined);
export function imageSource(image: ImageData): string | undefined {
  return image.data && /^image\/(png|jpeg|gif|webp|avif)$/i.test(image.mediaType) && /^[A-Za-z0-9+/]*={0,2}$/.test(image.data)
    ? `data:${image.mediaType};base64,${image.data}` : undefined;
}
export function withoutImagePlaceholders(text: string) {
  return text.split("\n").filter(line => !/^\s*\[(?:image|Image: source: [^\r\n]*)\]\s*$/i.test(line)).join("\n").trim();
}
