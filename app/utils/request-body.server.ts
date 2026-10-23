export class RequestBodyTooLargeError extends Error {
  constructor(maxBytes: number) {
    super(`Request body exceeds the ${maxBytes}-byte limit.`);
    this.name = "RequestBodyTooLargeError";
  }
}

export async function readRequestBodyLimited(
  request: Pick<Request, "headers" | "body">,
  maxBytes: number,
): Promise<ArrayBuffer> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError("maxBytes must be a non-negative safe integer.");
  }

  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    const declaredLength = Number(contentLength);
    if (!/^\d+$/.test(contentLength.trim()) || !Number.isSafeInteger(declaredLength)) {
      throw new Error("Invalid Content-Length header.");
    }
    if (declaredLength > maxBytes) {
      if (request.body) await request.body.cancel();
      throw new RequestBodyTooLargeError(maxBytes);
    }
  }

  if (!request.body) return new ArrayBuffer(0);

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  let done = false;
  try {
    while (!done) {
      const result = await reader.read();
      if (result.done) {
        done = true;
        continue;
      }
      const value = result.value;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          // The size limit remains authoritative if cancellation is unavailable.
        }
        throw new RequestBodyTooLargeError(maxBytes);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body.buffer;
}
