/**
 * Browser-side logo shrinking before upload: draw the image on a canvas at
 * most 1024 px on the long side and export it as WebP, lowering quality
 * until the file is under o1's 2 MB limit. Keeps the upload small (Vercel
 * caps request bodies at 4.5 MB) and spares the worker the work. Animated
 * GIFs are returned untouched: re-encoding would freeze them.
 */

export const LOGO_MAX_BYTES = 2 * 1024 * 1024;
const MAX_SIDE = 1024;
const QUALITIES = [0.85, 0.7, 0.55, 0.4];

export async function shrinkImage(file: File): Promise<File> {
  if (file.size <= LOGO_MAX_BYTES || file.type === "image/gif") return file;
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) return file;
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  for (const quality of QUALITIES) {
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/webp", quality));
    if (blob && blob.size <= LOGO_MAX_BYTES) return new File([blob], file.name.replace(/\.[^.]+$/, "") + ".webp", { type: "image/webp" });
  }
  return file;
}
