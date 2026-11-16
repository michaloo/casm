import { MAX_ATTACHMENT_BYTES, formatBytes, type Attachment, type ImageData, type Params, type Result } from "@casm/protocol";

// Phone photos are 4000px+ and several MB; agents read 2000px fine, and a
// message must stay well under the server's 16 MB socket frame.
export const MAX_SIDE = 2000;
export const MAX_BYTES = 5 * 1024 * 1024;
export const MAX_IMAGES = 10;
// Sent as is when this small and in a format every provider takes.
const KEEP_BYTES = 1.5 * 1024 * 1024;
const passthrough = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

const megabytes = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
const base64Bytes = (data: string) => Math.floor(data.length * 3 / 4);

// iOS may hand over HEIC photos with an empty type; trust the extension then.
const isImage = (file: File) => file.type.startsWith("image/") || (!file.type && /\.(heic|heif|png|jpe?g|webp|gif)$/i.test(file.name));

function read(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = () => reject(new Error("Could not read the file"));
    reader.readAsDataURL(blob);
  });
}

async function decode(file: File): Promise<{ source: CanvasImageSource; width: number; height: number; close: () => void }> {
  try {
    const bitmap = await createImageBitmap(file);
    return { source: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close() };
  } catch {
    // Safari decodes some formats (HEIC) only through <img>.
    const url = URL.createObjectURL(file);
    const img = new Image();
    try {
      img.src = url;
      await img.decode();
    } catch {
      URL.revokeObjectURL(url);
      throw new Error(`${file.name || "This image"} could not be read as an image.`);
    }
    return { source: img, width: img.naturalWidth, height: img.naturalHeight, close: () => URL.revokeObjectURL(url) };
  }
}

const encode = (canvas: HTMLCanvasElement, type: string, quality?: number) =>
  new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality));

/** One attachment, downscaled to MAX_SIDE and re-encoded when large; throws a message fit to show. */
export async function prepareImage(file: File): Promise<ImageData> {
  const name = file.name || "The image";
  if (passthrough.has(file.type) && file.size <= KEEP_BYTES) {
    const image = await decode(file).catch(() => null);
    const small = image && Math.max(image.width, image.height) <= MAX_SIDE;
    image?.close();
    if (small) return { mediaType: file.type, data: await read(file) };
  }
  const image = await decode(file);
  try {
    const scale = Math.min(1, MAX_SIDE / Math.max(image.width, image.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.width * scale));
    canvas.height = Math.max(1, Math.round(image.height * scale));
    const context = canvas.getContext("2d")!;
    // Screenshots stay crisp PNGs when that is small enough; photos become JPEG.
    let blob = file.type === "image/png" ? await encode((context.drawImage(image.source, 0, 0, canvas.width, canvas.height), canvas), "image/png") : null;
    if (!blob || blob.size > KEEP_BYTES) {
      context.fillStyle = "#fff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image.source, 0, 0, canvas.width, canvas.height);
      blob = await encode(canvas, "image/jpeg", 0.85);
    }
    if (!blob) throw new Error(`${name} could not be converted.`);
    const data = await read(blob);
    if (base64Bytes(data) > MAX_BYTES) throw new Error(`${name} is too large to attach (${megabytes(base64Bytes(data))} after resizing; the limit is ${megabytes(MAX_BYTES)}).`);
    return { mediaType: blob.type, data };
  } finally {
    image.close();
  }
}

// Any other file goes to the agent's project folder: uploaded in chunks when
// the message is sent, then named in agent.send (see upload.start). It stays
// in memory only: a reload drops it from the draft. `uploadId` once uploaded,
// so a retry or a message taken back and sent again reuses the saved file.
export type DraftFile = { file: File; uploadId?: string };

export const isImageFile = (file: File) => isImage(file);

/** The files of a paste or drop, images or not: `files` and `items`, once each. */
export function droppedFiles(data: DataTransfer | null): File[] {
  if (!data) return [];
  const all = [...Array.from(data.files), ...Array.from(data.items).filter((i) => i.kind === "file").map((i) => i.getAsFile())];
  const seen = new Set<string>();
  return all.filter((file): file is File => {
    if (!file) return false;
    const id = `${file.name}\n${file.size}\n${file.type}\n${file.lastModified}`;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

/** The attachment as the message will show it until the server says where it was saved. */
export const draftAttachment = (f: DraftFile): Attachment =>
  ({ name: f.file.name || "attachment", mediaType: f.file.type || "application/octet-stream", size: formatBytes(f.file.size) });

export function tooLarge(file: File): string | null {
  return file.size > MAX_ATTACHMENT_BYTES
    ? `${file.name || "The file"} is ${formatBytes(file.size)}, over the ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB limit for a file attachment.`
    : null;
}

type Call = <M extends "upload.start" | "upload.chunk">(method: M, params: Params<M>) => Promise<Result<M>>;

/** Uploads the files not uploaded yet, in chunks; `progress` gets the bytes sent of the total. */
export async function uploadFiles(files: DraftFile[], call: Call, progress: (sent: number, total: number) => void): Promise<string[]> {
  const total = files.reduce((n, f) => n + (f.uploadId ? 0 : f.file.size), 0);
  let sent = 0;
  for (const f of files) {
    if (f.uploadId) continue;
    const { uploadId, chunkSize } = await call("upload.start", { name: f.file.name || "attachment", size: f.file.size, mediaType: f.file.type || undefined });
    for (let offset = 0; offset < f.file.size; ) {
      const piece = f.file.slice(offset, offset + chunkSize);
      await call("upload.chunk", { uploadId, offset, data: await read(piece) });
      offset += piece.size;
      sent += piece.size;
      progress(sent, total);
    }
    f.uploadId = uploadId;
  }
  return files.map((f) => f.uploadId!);
}
