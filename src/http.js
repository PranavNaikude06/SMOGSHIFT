// Small HTTP helpers on top of node:http: safe headers, JSON in/out, client IP, static whitelist.

import { readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { AppError } from './errors.js';

export const SECURITY_HEADERS = Object.freeze({
  'Content-Security-Policy': [
    "default-src 'self'",
    "img-src 'self' data: blob:",
    "script-src 'self'",
    "style-src 'self'",
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; '),
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
});

/** Only these files are ever served; requests never touch the filesystem (no path traversal). */
const STATIC_ROUTES = Object.freeze([
  ['/', 'index.html'],
  ['/app.js', 'app.js'],
  ['/styles.css', 'styles.css'],
  ['/i18n/en.json', 'i18n/en.json'],
  ['/i18n/hi.json', 'i18n/hi.json'],
  ['/i18n/mr.json', 'i18n/mr.json'],
]);

const CONTENT_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
});

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {string | Buffer} body
 * @param {Record<string, string>} [headers]
 */
export function send(res, status, body, headers = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Length': Buffer.byteLength(body), ...headers });
  res.end(body);
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {unknown} data
 * @param {Record<string, string>} [headers]
 */
export function sendJson(res, status, data, headers = {}) {
  send(res, status, JSON.stringify(data), { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
}

/**
 * Reads and parses a JSON request body with a hard size limit.
 * @param {import('node:http').IncomingMessage} req
 * @param {number} maxBytes
 * @returns {Promise<unknown>}
 * @throws {AppError} 415 wrong type, 413 too large, 400 malformed
 */
export async function readJsonBody(req, maxBytes) {
  if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) {
    req.resume();
    throw new AppError('Send the request as JSON.', 415);
  }
  if (Number(req.headers['content-length'] ?? 0) > maxBytes) {
    req.resume();
    throw new AppError('Request is too large.', 413);
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new AppError('Request is too large.', 413);
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new AppError('Request body is not valid JSON.', 400);
  }
}

/**
 * Client IP for rate limiting. Behind Render's proxy the last X-Forwarded-For entry is the one the
 * proxy itself added; earlier entries are client-controlled and spoofable.
 * @param {import('node:http').IncomingMessage} req
 * @returns {string}
 */
export function clientIp(req) {
  const forwarded = String(req.headers['x-forwarded-for'] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return forwarded.at(-1) ?? req.socket.remoteAddress ?? 'unknown';
}

/**
 * Adds a gzip copy and a content-hash ETag to each static file, once, so requests do no work.
 * @param {Map<string, { type: string, body: Buffer }>} files
 * @returns {Map<string, { type: string, body: Buffer, gzip: Buffer, etag: string }>}
 */
export function prepareStaticFiles(files) {
  return new Map([...files].map(([route, file]) => [route, {
    ...file,
    gzip: gzipSync(file.body),
    etag: `"${createHash('sha256').update(file.body).digest('base64url').slice(0, 22)}"`,
  }]));
}

/**
 * Serves a prepared static file: 304 when the ETag matches, gzip when the client accepts it.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {{ type: string, body: Buffer, gzip: Buffer, etag: string }} file
 */
export function sendStatic(req, res, file) {
  const headers = { 'Content-Type': file.type, 'Cache-Control': 'no-cache', ETag: file.etag, Vary: 'Accept-Encoding' };
  if (req.headers['if-none-match'] === file.etag) {
    res.writeHead(304, { ...SECURITY_HEADERS, ...headers });
    return res.end();
  }
  const gzip = /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''));
  return send(res, 200, gzip ? file.gzip : file.body, gzip ? { ...headers, 'Content-Encoding': 'gzip' } : headers);
}

/**
 * Loads the whitelisted public files into memory once at startup. Missing files are skipped.
 * @param {string} publicDir
 * @returns {Promise<Map<string, { type: string, body: Buffer }>>}
 */
export async function loadStaticFiles(publicDir) {
  const files = new Map();
  for (const [route, file] of STATIC_ROUTES) {
    try {
      files.set(route, { type: CONTENT_TYPES[extname(file)], body: await readFile(join(publicDir, file)) });
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }
  return files;
}
