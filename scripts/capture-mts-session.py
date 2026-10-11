#!/usr/bin/env python3
"""Guarded own-session observation on emulator-5556; never physical devices.

Run --dry-run to compile and check local private-file handling without ADB,
Frida attachment, application launch or network requests. Runtime requires a
matching frida-server already running in the separately prepared emulator.
"""
import argparse
import json
import os
import signal
import stat
import subprocess
import sys
import tempfile
import threading
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PACKAGE = 'ru.mts.mymts'
SERIAL = 'emulator-5556'
HOSTS = {'auth.ssl.mts.ru', 'dialer.mts.ru', 'myconnect-acs.mts.ru'}
KINDS = {'startup-gate-ready', 'guard-ready', 'guard-failed', 'request-blocked',
         'request-headers', 'auth-parameters'}
HEADER_NAMES = {'authorization', 'x-user-token', 'x-device-id', 'x-profile-id',
                'x-msisdn', 'x-instance-id', 'x-callrec-id', 'x-client-id',
                'x-app-version', 'x-app-os-version', 'user-agent', 'cookie',
                'accept', 'content-type'}


class CaptureError(Exception):
    """Fixed error codes only: underlying exceptions may carry credentials."""


def metadata(kind, **fields):
    print(json.dumps({'kind': kind, **fields}, ensure_ascii=False), flush=True)


def private_dir(path):
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    if path.is_symlink() or not path.is_dir():
        raise CaptureError('invalid_private_directory')
    os.chmod(path, 0o700)


def private_json(path, value):
    """Atomic replacement through an exclusive 0600 file in the same folder."""
    if path.is_symlink():
        raise CaptureError('invalid_private_file')
    fd, temporary = tempfile.mkstemp(prefix='.capture-', dir=path.parent)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, 'w', encoding='utf-8') as stream:
            json.dump(value, stream, ensure_ascii=False, indent=2)
            stream.write('\n')
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass


def clean_event(payload):
    """Whitelist each stored field; never store JS errors, bodies or full URLs."""
    if not isinstance(payload, dict) or payload.get('kind') not in KINDS:
        raise CaptureError('invalid_agent_event')
    kind = payload['kind']
    result = {'kind': kind, 'time': datetime.now(timezone.utc).isoformat()}
    if kind == 'request-headers':
        host = payload.get('host')
        if host not in HOSTS or not isinstance(payload.get('headers'), dict):
            raise CaptureError('invalid_agent_event')
        result.update(host=host, method=payload.get('method'), route=payload.get('route'))
        result['headers'] = {str(k).lower(): v for k, v in payload['headers'].items()
                             if str(k).lower() in HEADER_NAMES and isinstance(v, str)
                             and len(v) <= 65536 and '\r' not in v and '\n' not in v}
    elif kind == 'auth-parameters':
        parameters = payload.get('parameters', {})
        if not isinstance(parameters, dict):
            raise CaptureError('invalid_agent_event')
        result['parameters'] = {k: v for k, v in parameters.items()
                                if k in {'device_id', 'mode', 'scope'}
                                and isinstance(v, str) and len(v) <= 16384}
    elif kind == 'request-blocked':
        # Diagnose blocked native routes locally; never print them. URL query
        # and arbitrary agent/error fields remain excluded.
        host, method, path = (payload.get(k) for k in ['host', 'method', 'path'])
        if isinstance(host, str) and (host == 'mts.ru' or host.endswith('.mts.ru')):
            result['host'] = host
        if isinstance(method, str) and method in {'GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'}:
            result['method'] = method
        if isinstance(path, str) and path.startswith('/') and len(path) <= 16384:
            result['path'] = path.split('?', 1)[0]
        result['self_test'] = payload.get('self_test') is True
    return result


class PrivateCapture:
    def __init__(self, directory):
        self.directory = directory
        private_dir(directory)
        self.latest = {'schema': 1, 'source': 'own-emulator-okhttp', 'headers_by_host': {},
                       'auth_parameters': {}}
        self.lock = threading.Lock()
        self.events = directory / 'events.jsonl'
        self.latest_path = directory / 'latest.json'
        if self.events.is_symlink():
            raise CaptureError('invalid_private_file')
        self.events_fd = os.open(self.events, os.O_WRONLY | os.O_APPEND | os.O_CREAT
                                 | getattr(os, 'O_NOFOLLOW', 0), 0o600)
        os.fchmod(self.events_fd, 0o600)
        private_json(self.latest_path, self.latest)

    def store(self, payload):
        event = clean_event(payload)
        with self.lock:
            if event['kind'] == 'request-headers':
                # Later builds contain headers added by native interceptors.
                self.latest['headers_by_host'].setdefault(event['host'], {}).update(event['headers'])
            elif event['kind'] == 'auth-parameters':
                self.latest['auth_parameters'].update(event['parameters'])
            self.latest['updated_at'] = event['time']
            os.write(self.events_fd, (json.dumps(event, ensure_ascii=False) + '\n').encode())
            os.fsync(self.events_fd)
            private_json(self.latest_path, self.latest)
        return event['kind']

    def close(self):
        with self.lock:
            if self.events_fd is not None:
                os.close(self.events_fd)
                self.events_fd = None


def agent_for_runtime(frida):
    major = int(frida.__version__.split('.', 1)[0])
    entrypoint = ROOT / 'instrument/mts-session-agent.js'
    if major == 16:
        # Frida 16 ships its Java bridge inside the runtime. Remove precisely
        # the module import, retaining every guard and capture implementation.
        first_line, newline, source = entrypoint.read_text(encoding='utf-8').partition('\n')
        if first_line != "import Java from 'frida-java-bridge';" or not newline:
            raise CaptureError('legacy_agent_import_mismatch')
        return source
    if major >= 17:
        compiler = frida.Compiler()
        # Frida 17's public Python API is build(), not compile().
        return compiler.build(str(entrypoint), project_root=str(ROOT),
                              source_maps='omitted', compression='none')
    raise CaptureError('unsupported_frida_runtime')


def compile_agent():
    try:
        import frida
        bundle = agent_for_runtime(frida)
        if not isinstance(bundle, str) or not bundle:
            raise CaptureError('agent_compile_failed')
        return frida, bundle
    except CaptureError:
        raise
    except Exception:
        raise CaptureError('agent_compile_failed') from None


def adb(args, *command, timeout=15):
    try:
        completed = subprocess.run([args.adb, '-s', args.serial, *command], check=True,
                                   capture_output=True, text=True, timeout=timeout)
        return completed.stdout.strip()
    except Exception:
        raise CaptureError('emulator_adb_failed') from None


def verify_emulator(args):
    if args.serial != SERIAL:
        raise CaptureError('physical_or_other_device_refused')
    if adb(args, 'shell', 'getprop', 'ro.kernel.qemu') != '1':
        raise CaptureError('physical_or_other_device_refused')


def run_capture(args, frida, bundle):
    verify_emulator(args)
    capture = PrivateCapture(ROOT / 'data' / 'emulator-session-capture')
    started = False
    forwarded = False
    session = None
    device = None
    stopped = threading.Event()
    guard_ready = threading.Event()
    gate_ready = threading.Event()
    failed = threading.Event()
    closing = threading.Event()

    def stop_app():
        # Only this function and verified run_capture issue emulator mutations.
        try:
            adb(args, 'shell', 'am', 'force-stop', PACKAGE)
        except CaptureError:
            failed.set()
            metadata('error', code='emulator_stop_failed')

    def on_detached(*_):
        # Do not trust/reveal arbitrary detach exception strings.
        if not closing.is_set():
            stop_app()
            metadata('detached')
        stopped.set()

    def on_message(message, _data):
        if closing.is_set():
            return
        try:
            if message.get('type') != 'send':
                # An error object may embed URLs, OAuth codes or token headers.
                failed.set()
                stop_app()
                metadata('error', code='agent_runtime_failed')
                stopped.set()
                return
            payload = message.get('payload')
            kind = capture.store(payload)
            metadata('event', event_kind=kind)
            if kind == 'guard-ready':
                if payload.get('policy_test_passed') is not True:
                    raise CaptureError('guard_self_test_failed')
                guard_ready.set()
            elif kind == 'startup-gate-ready':
                gate_ready.set()
            elif kind == 'guard-failed':
                failed.set()
                stop_app()
                stopped.set()
        except Exception:
            failed.set()
            stop_app()
            metadata('error', code='capture_event_failed')
            stopped.set()

    def on_signal(_signum, _frame):
        stopped.set()

    previous_signals = {sig: signal.signal(sig, on_signal) for sig in [signal.SIGINT, signal.SIGTERM]}
    try:
        # The target is verified before forward/spawn/attach; never get_usb_device.
        adb(args, 'forward', '--no-rebind', f'tcp:{args.port}', f'tcp:{args.server_port}')
        forwarded = True
        manager = frida.get_device_manager()
        # The loopback service also authenticates the local caller. The token
        # is private to this project and never appears in output.
        server_token = (ROOT / 'data' / 'emulator-frida-token.txt').read_text().strip()
        if not server_token:
            raise CaptureError('instrumentation_token_missing')
        device = manager.add_remote_device(f'127.0.0.1:{args.port}', token=server_token)
        adb(args, 'shell', 'am', 'force-stop', PACKAGE)
        pid = device.spawn([PACKAGE])
        started = True
        session = device.attach(pid)
        session.on('detached', on_detached)
        script = session.create_script(bundle, name='mts-session-guard', runtime='qjs')
        script.on('message', on_message)
        script.load()
        if not gate_ready.wait(args.ready_timeout) or failed.is_set():
            raise CaptureError('startup_gate_not_ready')
        # Java.perform installs the app hook before Application.onCreate. Until
        # then the startup gate refuses Application.onCreate; no login is ready.
        device.resume(pid)
        if not guard_ready.wait(args.ready_timeout) or failed.is_set():
            raise CaptureError('guard_not_ready')
        status = script.exports_sync.status()
        if status.get('ready') is not True or status.get('fatal') or status.get('policy_test_passed') is not True:
            raise CaptureError('guard_status_failed')
        guard_test = script.exports_sync.guardtest()
        if guard_test.get('passed') is not True or guard_test.get('network_executed') is not False:
            raise CaptureError('guard_builder_test_failed')
        metadata('ready', guard_ready=True, serial=SERIAL,
                 directory=str(capture.directory), tls_validation='unchanged',
                 builder_guard_cases_checked=guard_test.get('checked'))
        while not stopped.wait(0.5):
            pass
        if failed.is_set():
            raise CaptureError('capture_stopped_after_guard_failure')
    except CaptureError:
        raise
    except Exception:
        raise CaptureError('capture_runtime_failed') from None
    finally:
        closing.set()
        if started:
            # Stop before removing the hook; don't permit an unguarded refresh.
            stop_app()
        if session is not None:
            try:
                session.detach()
            except Exception:
                pass
        if forwarded:
            try:
                adb(args, 'forward', '--remove', f'tcp:{args.port}')
            except CaptureError:
                pass
        capture.close()
        for sig, previous in previous_signals.items():
            signal.signal(sig, previous)
        metadata('stopped', app_force_stop_attempted=started)


def dry_check(bundle, runtime_major):
    # Local files only, synthetic sentinel; assert no unwanted payload persisted.
    with tempfile.TemporaryDirectory(prefix='mts-capture-check-') as temporary:
        capture = PrivateCapture(Path(temporary) / 'private')
        capture.store({'kind': 'request-headers', 'host': 'auth.ssl.mts.ru',
                       'method': 'GET', 'route': 'auth',
                       'headers': {'x-device-id': 'synthetic-test', 'unknown': 'discarded'},
                       'url': 'discarded', 'body': 'discarded'})
        capture.store({'kind': 'auth-parameters', 'parameters':
                       {'mode': 'Universal', 'code': 'discarded', 'state': 'discarded'}})
        capture.store({'kind': 'request-blocked', 'host': 'dialer.mts.ru',
                       'method': 'POST', 'path': '/local-test-path?code=discarded'})
        capture.close()
        for path in [capture.events, capture.latest_path]:
            assert stat.S_IMODE(path.stat().st_mode) == 0o600
            assert 'discarded' not in path.read_text()
        assert stat.S_IMODE(capture.directory.stat().st_mode) == 0o700
    metadata('dry-run-ok', compiled=runtime_major >= 17, source_prepared=True,
             bundle_bytes=len(bundle.encode()),
             runtime_major=runtime_major, java_bridge='built-in' if runtime_major == 16 else 'npm',
             private_modes_checked=True, extra_fields_discarded=True, device_contacted=False,
             runtime_injection_tested=False)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--serial', default=SERIAL)
    parser.add_argument('--adb', default='adb', help='Explicit Android SDK adb executable')
    parser.add_argument('--port', type=int, default=27043, help='Local ADB-forwarded Frida port')
    parser.add_argument('--server-port', type=int, default=27042)
    parser.add_argument('--ready-timeout', type=float, default=30)
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args()
    if args.serial != SERIAL:
        raise CaptureError('physical_or_other_device_refused')
    if not all(1024 <= p <= 65535 for p in [args.port, args.server_port]) or not 1 <= args.ready_timeout <= 60:
        raise CaptureError('invalid_capture_options')
    frida, bundle = compile_agent()
    if args.dry_run:
        dry_check(bundle, int(frida.__version__.split('.', 1)[0]))
    else:
        run_capture(args, frida, bundle)


if __name__ == '__main__':
    os.umask(0o077)
    try:
        main()
    except CaptureError as error:
        metadata('error', code=str(error))
        sys.exit(1)
    except Exception:
        metadata('error', code='capture_failed')
        sys.exit(1)
