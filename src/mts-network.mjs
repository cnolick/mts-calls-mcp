import { request as httpsRequest } from 'node:https';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGunzip, createInflate, createBrotliDecompress } from 'node:zlib';
import { rootCertificates } from 'node:tls';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const allowedHosts = new Set(['auth.ssl.mts.ru', 'dialer.mts.ru']);
let tlsPromise;
let callsCaPromise;
async function callsTls() {
  // dialer.mts.ru presents an MTS private CA chain. Trust the public root
  // shipped in the original app, in addition to Node's bundled roots.
  // This trust applies only to this fixed host; hostname checks stay enabled.
  if (!callsCaPromise) callsCaPromise = readFile(resolve(root, 'certs/mts-class2-root-g2.crt'), 'utf8');
  return { ca: [...rootCertificates, await callsCaPromise] };
}
async function clientTls() {
  if (!tlsPromise) tlsPromise = Promise.all([
    readFile(process.env.MTS_CLIENT_PFX_FILE || resolve(root, 'data/native-app-channel/production-modern.pfx')),
    readFile(process.env.MTS_CLIENT_PFX_PASSWORD_FILE || resolve(root, 'data/native-app-channel/production-modern.passphrase'), 'utf8'),
  ]).then(([pfx, passphrase]) => ({ pfx, passphrase }));
  try { return await tlsPromise; }
  catch (error) {
    tlsPromise = undefined;
    if (error.code === 'ENOENT') return {};
    throw new Error('Не удалось загрузить локальный клиентский TLS-сертификат МТС.');
  }
}

export async function mtsFetch(address, options = {}) {
  const url = new URL(address);
  if (url.protocol !== 'https:' || !allowedHosts.has(url.hostname) || (url.port && url.port !== '443')) throw new Error('Недопустимый адрес API МТС.');
  // The app's authSSL client uses mTLS. The calls SDK creates a separate
  // SSLContext with null KeyManagers and therefore sends no client certificate.
  const tls = url.hostname === 'auth.ssl.mts.ru' ? await clientTls() : await callsTls();
  const body = options.body;
  const headers = { 'Accept-Encoding': 'gzip, deflate, br', ...options.headers };
  if (body !== undefined) headers['Content-Length'] = Buffer.byteLength(body);
  return new Promise((resolveResponse, reject) => {
    const request = httpsRequest(url, { ...tls, method: options.method || 'GET', headers, rejectUnauthorized: true, signal: options.signal }, response => {
      let stream = response;
      const encoding = response.headers['content-encoding'];
      if (encoding === 'gzip') stream = response.pipe(createGunzip());
      else if (encoding === 'deflate') stream = response.pipe(createInflate());
      else if (encoding === 'br') stream = response.pipe(createBrotliDecompress());
      const chunks = [];
      let bytes = 0;
      stream.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > 8 * 1024 * 1024) { request.destroy(); stream.destroy(); reject(new Error('Ответ МТС превысил допустимый размер.')); }
        else chunks.push(chunk);
      });
      stream.on('error', reject);
      stream.on('end', () => {
        const resultHeaders = new Headers();
        for (const [key, values] of Object.entries(response.headers)) {
          if (['content-encoding', 'content-length'].includes(key) || values === undefined) continue;
          for (const value of Array.isArray(values) ? values : [values]) resultHeaders.append(key, value);
        }
        const noBody = [204, 205, 304].includes(response.statusCode);
        resolveResponse(new Response(noBody ? null : Buffer.concat(chunks), { status: response.statusCode, headers: resultHeaders }));
      });
    });
    request.on('error', reject);
    if (body !== undefined) request.write(body);
    request.end();
  });
}
