import { MtsError } from './session.mjs';

export function selectPhoneSerial(deviceList, preferred = process.env.MTS_DEVICE_SERIAL) {
  const devices = deviceList.split('\n').map(line => line.trim().split(/\s+/)).filter(parts => parts[1] === 'device').map(parts => parts[0]);
  if (preferred) {
    if (devices.includes(preferred)) return preferred;
    throw new MtsError('phone_required', 'Выбранный Android не подключён или отладка по USB не разрешена.');
  }
  const physical = devices.filter(serial => !/^emulator-\d+$/.test(serial));
  if (physical.length === 1) return physical[0];
  if (devices.length === 1) return devices[0];
  throw new MtsError('phone_required', 'Подключи один телефон Android или укажи его через MTS_DEVICE_SERIAL.');
}
