export const boundary = { error: () => null, headers: () => ({}) };
export const authenticate = { admin: () => null };
export const prisma = {};
export default {};
export const MAX_CSV_BYTES = 5 * 1024 * 1024;
export const MAX_CSV_ROWS = 2500;
export const createHash = () => ({ update: () => ({ digest: () => "" }) });
export const randomUUID = () => "mock-uuid";
export class CsvFormatError extends Error {}
export const parseCsvPreview = () => ({});
export const readRequestBodyLimited = () => ({});
export class RequestBodyTooLargeError extends Error {}
export const getGraphQLData = () => ({});
