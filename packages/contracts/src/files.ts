import { z } from "zod";

/**
 * The stored-file routes (slice 7.6, stories 32 and 33): the two paths outside
 * the RPC envelope and the upload's answer shape.
 *
 * An attachment's bytes and a download's bytes are raw bodies, not RPC JSON,
 * so both routes are plain HTTP — but their shapes are still transport truth,
 * and this module is where a server mounts them and a client dials them. The
 * patterns are what the API registers and its limits register names; the
 * concrete builders are what a client puts on the wire, so the two can never
 * disagree about where a file lives.
 */

/** The route pattern an attachment upload is mounted on (Hono parameter syntax). */
export const attachmentUploadRoutePath = "/threads/:threadId/attachments";
/** The route pattern a stored file is downloaded from. */
export const fileDownloadRoutePath = "/files/:fileId";

/** The path a client uploads one attachment for a thread to. */
export function attachmentUploadPath(threadId: string): string {
  return `/threads/${encodeURIComponent(threadId)}/attachments`;
}

/**
 * The path a stored file is downloaded from. Attachments and artifacts share
 * it because they share the addressing: a file id the actor's space resolves,
 * never a storage key or a filesystem path.
 */
export function fileDownloadPath(fileId: string): string {
  return `/files/${encodeURIComponent(fileId)}`;
}

/** What an upload answers; a send addresses `id` in `attachmentIds`. */
export const uploadedAttachmentSchema = z.object({
  id: z.uuid(),
  filename: z.string().min(1),
  contentType: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
});

export type UploadedAttachment = z.infer<typeof uploadedAttachmentSchema>;
