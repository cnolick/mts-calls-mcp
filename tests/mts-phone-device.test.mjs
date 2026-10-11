import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectPhoneSerial } from '../src/mts-phone-device.mjs';

test('USB transcript tools retain the physical phone when a research emulator is also running', () => {
  assert.equal(selectPhoneSerial('List of devices attached\nphone-a\tdevice\nemulator-5556\tdevice\n', ''), 'phone-a');
});
test('multiple physical phones require explicit selection', () => {
  const devices = 'phone-a\tdevice\nphone-b\tdevice\nemulator-5556\tdevice\n';
  assert.throws(() => selectPhoneSerial(devices, ''), error => error.code === 'phone_required');
  assert.equal(selectPhoneSerial(devices, 'phone-b'), 'phone-b');
});
test('an unavailable or unauthorized selected device is never used', () => {
  assert.throws(() => selectPhoneSerial('phone-a\tunauthorized\n', 'phone-a'), error => error.code === 'phone_required');
});
