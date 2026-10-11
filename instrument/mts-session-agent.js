import Java from 'frida-java-bridge';

// This agent observes this emulator's own My MTS session. No TLS hooks, body
// capture, certificate changes or integrity-check evasion are used.
const CAPTURE_HOSTS = new Set(['auth.ssl.mts.ru', 'dialer.mts.ru', 'myconnect-acs.mts.ru']);
const HEADER_NAMES = new Set([
  'authorization', 'x-user-token', 'x-device-id', 'x-profile-id', 'x-msisdn',
  'x-instance-id', 'x-callrec-id', 'x-client-id', 'x-app-version',
  'x-app-os-version', 'user-agent', 'cookie', 'accept', 'content-type',
]);
const AUTH_GETS = new Set(['/login/state', '/idtoken', '/accesstoken']);
let ready = false;
let fatal = false;
let blockCount = 0;
let requestBuild;
let SecurityException;
let selfTesting = false;

function mtsHost(host) {
  return host === 'mts.ru' || host.endsWith('.mts.ru');
}

function pathOnly(value) {
  let path = value.split('?')[0].toLowerCase();
  for (let i = 0; i < 2; i++) {
    try { path = decodeURIComponent(path); } catch { return '/invalid-path'; }
  }
  return path.replace(/\/+$/, '') || '/';
}

function permitted(host, method, value) {
  if (!mtsHost(host)) return true;
  const path = pathOnly(value);
  // Deny these even when an API uses a state-changing GET.
  if (path === '/invalid-path' || method === 'DELETE' ||
      /(?:^|\/)(?:link-my-mts[^/]*|init-sms|share|logout|logoff|revoke|deactivate|unsubscribe|subscribe|connect|disconnect|activate|activation|confirm|enable|disable|change-instance[^/]*|refresh-instance-settings)(?:\/|$)/.test(path) ||
      /(?:^|\/)(?:subscription|subscriptions|service|services)\/(?:change|set|add|remove|purchase|activate|deactivate|connect|disconnect)(?:\/|$)/.test(path)) return false;
  if (host === 'auth.ssl.mts.ru' && method === 'POST' && path === '/login/usertoken') return true;
  if (host === 'dialer.mts.ru' && method === 'POST' &&
      /^\/bff\/api\/v1\/calls\/[^/]+\/records\/[^/]+\/details$/.test(path)) return true;
  // Unknown writes are blocked, including new subscription/activation routes.
  return method === 'GET' || method === 'HEAD' || method === 'OPTIONS';
}

function routeLabel(host, value) {
  const path = pathOnly(value);
  if (host === 'auth.ssl.mts.ru' && (AUTH_GETS.has(path) || path === '/login/usertoken')) return 'auth';
  if (/\/calls$/.test(path)) return 'calls-list';
  if (/\/records\/[^/]+\/details$/.test(path)) return 'calls-details';
  return 'other';
}

function policySelfTest() {
  const cases = [
    ['auth.ssl.mts.ru', 'GET', '/login/state', true],
    ['auth.ssl.mts.ru', 'POST', '/login/userToken', true],
    ['auth.ssl.mts.ru', 'GET', '/idToken', true],
    ['dialer.mts.ru', 'GET', '/bff/api/v1/calls', true],
    ['dialer.mts.ru', 'POST', '/bff/api/v1/calls/a/records/b/details', true],
    ['myconnect-acs.mts.ru', 'POST', '/mm/v2/link-my-mts', false],
    ['myconnect-acs.mts.ru', 'GET', '/mm/v2/link-my-mts-by-callrec-token', false],
    ['dialer.mts.ru', 'POST', '/bff/api/v1/auth/activation/init', false],
    ['dialer.mts.ru', 'POST', '/bff/api/v1/auth/activation/confirm', false],
    ['dialer.mts.ru', 'POST', '/bff/api/v1/auth/activation/refresh', false],
    ['dialer.mts.ru', 'GET', '/bff/api/v1/auth/activation', false],
    ['www.mts.ru', 'DELETE', '/anything', false],
    ['www.mts.ru', 'POST', '/new-unknown-write-route', false],
    ['www.mts.ru', 'GET', '/subscriptions/activate', false],
    ['myconnect-acs.mts.ru', 'POST', '/mm/v2/refresh-instance-settings', false],
    ['myconnect-acs.mts.ru', 'GET', '/mm/v2/%6cink-my-mts', false],
    ['myconnect-acs.mts.ru', 'GET', '/mm/v2/%256cink-my-mts', false],
    ['auth.ssl.mts.ru', 'GET', '/logout', false],
    ['dialer.mts.ru', 'GET', '/bff/api/v1/calls/a/records/b/share', false],
    ['evil-mts.ru', 'POST', '/unrelated', true],
  ];
  return cases.every(([h, m, p, want]) => permitted(h, m, p) === want);
}

function emitFatal() {
  fatal = true;
  ready = false;
  send({ kind: 'guard-failed' });
}

function deny(details = {}) {
  blockCount++;
  send({ kind: 'request-blocked', ...details, self_test: selfTesting });
  throw SecurityException.$new('MTS_SESSION_CAPTURE_BLOCKED');
}

function captureRequest(request) {
  const url = request.url();
  const host = String(url.host()).toLowerCase();
  const method = String(request.method()).toUpperCase();
  const path = String(url.encodedPath());
  if (!permitted(host, method, path)) deny({ host, method, path });
  if (selfTesting || !CAPTURE_HOSTS.has(host)) return;
  const headers = {};
  const values = request.headers();
  for (let i = 0; i < values.size(); i++) {
    const name = String(values.name(i)).toLowerCase();
    if (HEADER_NAMES.has(name)) headers[name] = String(values.value(i));
  }
  // send() is received by the private Python writer, never console/stdout.
  send({ kind: 'request-headers', host, method, route: routeLabel(host, path), headers });
}

function captureAuthParameters(value) {
  try {
    const uri = Java.use('android.net.Uri').parse(value);
    const host = String(uri.getHost()).toLowerCase();
    if (host !== 'login.mts.ru' && host !== 'auth.ssl.mts.ru') return;
    const path = String(uri.getPath());
    if (!/\/oauth2\/authorize$/.test(path)) return;
    const parameters = {};
    for (const name of ['device_id', 'mode', 'scope']) {
      const v = uri.getQueryParameter(name);
      if (v !== null) parameters[name] = String(v);
    }
    send({ kind: 'auth-parameters', parameters });
  } catch {
    // Never emit the URL or exception: either can contain an OAuth code.
  }
}

function install() {
  try {
    SecurityException = Java.use('java.lang.SecurityException');
    if (!policySelfTest()) throw new Error('guard-test-failed');
    const Builder = Java.use('okhttp3.Request$Builder');
    requestBuild = Builder.build.overload();
    requestBuild.implementation = function () {
      const request = requestBuild.call(this);
      if (fatal) deny();
      // All policy/extraction errors fail closed; no raw exception is sent.
      try { captureRequest(request); } catch (e) {
        // Our fixed SecurityException is safe to propagate; other failures
        // also stop the request rather than silently bypassing the guard.
        if (!String(e).includes('MTS_SESSION_CAPTURE_BLOCKED')) emitFatal();
        throw SecurityException.$new('MTS_SESSION_CAPTURE_BLOCKED');
      }
      return request;
    };
    const WebView = Java.use('android.webkit.WebView');
    for (const signature of [['java.lang.String'], ['java.lang.String', 'java.util.Map']]) {
      const loadUrl = WebView.loadUrl.overload(...signature);
      loadUrl.implementation = function (...args) {
        captureAuthParameters(args[0]);
        return loadUrl.call(this, ...args);
      };
    }
    ready = true;
    send({ kind: 'guard-ready', policy_test_passed: true, hook: 'okhttp3.Request$Builder.build' });
  } catch {
    emitFatal();
  }
}

rpc.exports = {
  status() { return { ready, fatal, block_count: blockCount, policy_test_passed: policySelfTest() }; },
  guardtest() {
    if (!ready || fatal) return { passed: false };
    // Construct actual OkHttp requests; never newCall(), enqueue() or execute().
    // This checks the replacement build implementation, not only its predicate.
    return Java.performNow(() => {
      const Builder = Java.use('okhttp3.Request$Builder');
      const Body = Java.use('okhttp3.RequestBody');
      const createBody = Body.create.overload('okhttp3.MediaType', 'java.lang.String');
      const cases = [
        ['https://auth.ssl.mts.ru/login/state', 'GET', true],
        ['https://auth.ssl.mts.ru/login/userToken', 'POST', true],
        ['https://dialer.mts.ru/bff/api/v1/calls', 'GET', true],
        ['https://dialer.mts.ru/bff/api/v1/calls/test/records/test/details', 'POST', true],
        ['https://myconnect-acs.mts.ru/mm/v2/link-my-mts', 'GET', false],
        ['https://myconnect-acs.mts.ru/mm/v2/link-my-mts', 'POST', false],
        ['https://myconnect-acs.mts.ru/mm/v2/link-my-mts-by-callrec-token', 'POST', false],
        ['https://dialer.mts.ru/bff/api/v1/auth/activation/init', 'POST', false],
        ['https://dialer.mts.ru/bff/api/v1/auth/activation/confirm', 'POST', false],
        ['https://dialer.mts.ru/bff/api/v1/calls/test/records/test/share', 'GET', false],
        ['https://auth.ssl.mts.ru/logout', 'GET', false],
        ['https://dialer.mts.ru/bff/api/v1/calls/test', 'DELETE', false],
      ];
      let passed = 0;
      selfTesting = true;
      try {
        for (const [url, method, allowed] of cases) {
          let didBuild = false;
          let blocked = false;
          try {
            const builder = Builder.$new().url(url);
            const body = method === 'POST' ? createBody.call(Body, null, '{}') : null;
            builder.method(method, body);
            builder.build();
            didBuild = true;
          } catch (error) {
            // Only accept our fixed block marker; unrelated overload/class
            // errors must not masquerade as a successful guard test.
            blocked = String(error).includes('MTS_SESSION_CAPTURE_BLOCKED');
          }
          if ((allowed && didBuild) || (!allowed && blocked)) passed++;
        }
      } catch {
        return { passed: false, checked: cases.length };
      } finally {
        selfTesting = false;
      }
      return { passed: passed === cases.length, checked: cases.length, network_executed: false };
    });
  },
};

try {
  if (!Java.available) throw new Error('java-unavailable');
  // Install a framework startup gate while the spawned process is suspended.
  // Java.perform then installs the app-class hook when its loader is ready.
  Java.performNow(() => {
    SecurityException = Java.use('java.lang.SecurityException');
    const Instrumentation = Java.use('android.app.Instrumentation');
    const onCreate = Instrumentation.callApplicationOnCreate.overload('android.app.Application');
    onCreate.implementation = function (application) {
      if (!ready || fatal) {
        emitFatal();
        throw SecurityException.$new('MTS_SESSION_CAPTURE_GUARD_NOT_READY');
      }
      return onCreate.call(this, application);
    };
  });
  Java.perform(install);
  send({ kind: 'startup-gate-ready' });
} catch {
  emitFatal();
}
