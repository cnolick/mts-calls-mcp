import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { parsePhoneTranscript, phoneScrollGeometry } from './mts-phone.mjs';
import { MtsError } from './session.mjs';
import { selectPhoneSerial } from './mts-phone-device.mjs';

const exec = promisify(execFile);
async function phoneTransport(adb) {
  let serial;
  try {
    const { stdout } = await exec(adb, ['devices'], { timeout: 5000, maxBuffer: 64 * 1024 });
    serial = selectPhoneSerial(stdout);
  } catch (error) {
    if (error instanceof MtsError) throw error;
    throw new MtsError('phone_unavailable', 'Не удалось подключиться к Android через ADB.');
  }
  return {
    async capture() {
      const path = `/sdcard/mts-transcript-${randomUUID()}.xml`;
      try {
        await exec(adb, ['-s', serial, 'shell', 'uiautomator', 'dump', path], { timeout: 15000, maxBuffer: 64 * 1024 });
        return (await exec(adb, ['-s', serial, 'shell', 'cat', path], { timeout: 5000, maxBuffer: 2 * 1024 * 1024 })).stdout;
      } finally { await exec(adb, ['-s', serial, 'shell', 'rm', '-f', path], { timeout: 5000 }).catch(() => {}); }
    },
    async swipe(geometry, direction) {
      const start = direction === 'forward' ? geometry.bottom : geometry.top;
      const end = direction === 'forward' ? geometry.top : geometry.bottom;
      await exec(adb, ['-s', serial, 'shell', 'input', 'swipe', String(geometry.x), String(start), String(geometry.x), String(end), '350'], { timeout: 5000 });
    },
  };
}

export function mergeTranscriptScreens(screens) {
  const lines = [];
  for (const screen of screens) {
    let overlap = 0;
    for (let size = Math.min(lines.length, screen.lines.length); size >= 2; size--) {
      if (lines.slice(-size).every((line, i) => line === screen.lines[i])) { overlap = size; break; }
    }
    lines.push(...screen.lines.slice(overlap));
  }
  return lines;
}

// The caller must authorize ADB scrolling. The ordinary read tool never calls
// this function; it is kept separate because scrolling changes screen state.
export async function collectOpenPhoneTranscript({ maxScreens = 20, transport, signal, adb = process.env.MTS_ADB_PATH || '/opt/homebrew/bin/adb' } = {}) {
  if (!Number.isInteger(maxScreens) || maxScreens < 1 || maxScreens > 40) throw new MtsError('invalid_input', 'Допустимо от 1 до 40 экранов в каждом направлении.');
  const io = transport || await phoneTransport(adb);
  const deadline = AbortSignal.any([AbortSignal.timeout(240000), ...(signal ? [signal] : [])]);
  function checkCancelled() {
    if (deadline.aborted) throw new MtsError('collection_cancelled', 'Сбор расшифровки остановлен по отмене или лимиту времени.');
  }
  let identity;
  async function snapshot() {
    checkCancelled();
    const xml = await io.capture();
    checkCancelled();
    const result = parsePhoneTranscript(xml);
    const geometry = phoneScrollGeometry(xml);
    if (identity && identity !== geometry.conversation) throw new MtsError('phone_screen_changed', 'На телефоне открыт другой разговор. Сбор остановлен.');
    identity = geometry.conversation;
    return { result, geometry };
  }
  try {
    let current = await snapshot();
    let reachedTop = false, reachedEnd = false, scrolls = 0;
    for (let i = 0; i < maxScreens; i++) {
      checkCancelled();
      await io.swipe(current.geometry, 'backward'); scrolls++;
      const next = await snapshot();
      if (next.result.text === current.result.text) { reachedTop = true; current = next; break; }
      current = next;
    }
    const screens = [current.result];
    for (let i = 0; i < maxScreens; i++) {
      checkCancelled();
      await io.swipe(current.geometry, 'forward'); scrolls++;
      const next = await snapshot();
      if (next.result.text === current.result.text) { reachedEnd = true; break; }
      screens.push(next.result); current = next;
    }
    const lines = mergeTranscriptScreens(screens);
    return { source: 'android_ui', coverage: 'open_conversation_scroll', full_transcript: false, reached_top: reachedTop, reached_end: reachedEnd, boundary_detection: 'screen_text_stopped_changing_after_swipe', screens: screens.map(screen => ({ lines: screen.lines })), scrolls, lines, text: lines.join('\n'), note: 'Сохранены экраны открытого разговора. Границы определены по прекращению изменения текста; склейка перекрытий приблизительная. Исходные фрагменты доступны в screens. Телефон остаётся в конце просмотренного диапазона.' };
  } catch (error) {
    if (error instanceof MtsError) throw error;
    throw new MtsError('phone_unavailable', 'Не удалось собрать расшифровку. Разблокируй телефон и открой разговор.');
  }
}
