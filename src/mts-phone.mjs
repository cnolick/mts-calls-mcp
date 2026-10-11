import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { MtsError } from './session.mjs';
import { selectPhoneSerial } from './mts-phone-device.mjs';

const exec = promisify(execFile);
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '', preserveOrder: true });

function transcriptNodes(xml) {
  if (XMLValidator.validate(xml) !== true || /<!DOCTYPE|<!ENTITY/i.test(xml)) throw new MtsError('phone_response_invalid', 'Не удалось прочитать экран телефона.');
  const nodes = [];
  function walk(items) {
    for (const item of items || []) {
      const attrs = item[':@'];
      if (item.node && attrs?.package === 'ru.mts.mymts') {
        const text = attrs.text || attrs['content-desc'];
        const bounds = attrs.bounds?.match(/^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/)?.slice(1).map(Number);
        if (bounds) nodes.push({ text, bounds, scrollable: attrs.scrollable === 'true', password: attrs.password === 'true' });
      }
      for (const [key, value] of Object.entries(item)) if (key !== ':@' && Array.isArray(value)) walk(value);
    }
  }
  walk(parser.parse(xml));
  return nodes;
}

export function parsePhoneTranscript(xml) {
  const nodes = transcriptNodes(xml).filter(n => n.text);
  // In the observed 6.77 transcript view the contact/number toolbar is above
  // the conversation. Refuse call-list and login screens instead of exporting
  // arbitrary UI or mistaking the call-list preview for a full conversation.
  const phone = nodes.find(n => /^\+7[\d ()-]+$/.test(n.text) && n.bounds[1] < 350);
  if (!phone || nodes.some(n => n.password || ['Звонки', 'Мой МТС', 'Введите код', 'Вход в МТС'].includes(n.text))) {
    throw new MtsError('transcript_not_open', 'Разблокируй телефон и открой полную расшифровку разговора в «Мой МТС».');
  }
  const lines = nodes.filter(n => n.bounds[1] >= phone.bounds[3]).sort((a, b) => a.bounds[1] - b.bounds[1]).map(n => n.text);
  if (!lines.length) throw new MtsError('transcript_not_open', 'На экране нет текста расшифровки.');
  return { source: 'android_ui', coverage: 'current_screen', full_transcript: false, lines, text: lines.join('\n'), note: 'Только текст, доступный на текущем экране. Прокрути разговор на телефоне и вызови инструмент повторно для следующего фрагмента.' };
}

export function phoneScrollGeometry(xml) {
  // Screen validation always happens before deciding any input coordinates.
  parsePhoneTranscript(xml);
  const nodes = transcriptNodes(xml);
  const phone = nodes.find(n => /^\+7[\d ()-]+$/.test(n.text || '') && n.bounds[1] < 350);
  const regions = nodes.filter(n => n.scrollable && n.bounds[2] - n.bounds[0] > 200 && n.bounds[3] - n.bounds[1] > 500);
  regions.sort((a, b) => ((b.bounds[2] - b.bounds[0]) * (b.bounds[3] - b.bounds[1])) - ((a.bounds[2] - a.bounds[0]) * (a.bounds[3] - a.bounds[1])));
  const bounds = regions[0]?.bounds;
  if (!bounds) throw new MtsError('phone_scroll_unavailable', 'Не найдено поле прокрутки расшифровки.');
  const height = bounds[3] - bounds[1];
  return { x: Math.round((bounds[0] + bounds[2]) / 2), top: Math.max(phone.bounds[3] + 50, Math.round(bounds[1] + height * 0.22)), bottom: Math.round(bounds[3] - height * 0.20), conversation: phone.text };
}

export async function readOpenPhoneTranscript({ adb = process.env.MTS_ADB_PATH || '/opt/homebrew/bin/adb' } = {}) {
  let serial;
  try {
    const { stdout } = await exec(adb, ['devices'], { timeout: 5000, maxBuffer: 64 * 1024 });
    serial = selectPhoneSerial(stdout);
  } catch (error) {
    if (error instanceof MtsError) throw error;
    throw new MtsError('phone_unavailable', 'Не удалось подключиться к Android через ADB.');
  }
  const path = `/sdcard/mts-transcript-${randomUUID()}.xml`;
  try {
    await exec(adb, ['-s', serial, 'shell', 'uiautomator', 'dump', path], { timeout: 15000, maxBuffer: 64 * 1024 });
    const { stdout } = await exec(adb, ['-s', serial, 'shell', 'cat', path], { timeout: 5000, maxBuffer: 2 * 1024 * 1024 });
    return parsePhoneTranscript(stdout);
  } catch (error) {
    if (error instanceof MtsError) throw error;
    throw new MtsError('phone_unavailable', 'Не удалось прочитать экран телефона. Разблокируй его и открой расшифровку.');
  } finally {
    await exec(adb, ['-s', serial, 'shell', 'rm', '-f', path], { timeout: 5000 }).catch(() => {});
  }
}
