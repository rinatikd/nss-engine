import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
  safeConnectionErrorCode,
  backgroundConnectionStatusLabel
} from '../extension/connection-diagnostic.js';

test('a disconnected status preserves the last explicit Connect error',()=>{
  assert.equal(
    backgroundConnectionStatusLabel('disconnected',null,'OFFSCREEN_UNAVAILABLE'),
    'Соединение не установлено · последняя ошибка: OFFSCREEN_UNAVAILABLE'
  );
});

test('coordinator ACK errors retain their bounded stable code',()=>{
  assert.equal(
    safeConnectionErrorCode('BACKGROUND_START:ACK_TIMEOUT'),
    'BACKGROUND_START:ACK_TIMEOUT'
  );
});

test('arbitrary messages are replaced and never rendered',()=>{
  assert.equal(safeConnectionErrorCode('Bearer secret-token server said no'),'CONNECT_FAILED');
  assert.equal(
    backgroundConnectionStatusLabel('disconnected',null,'Bearer secret-token'),
    'Соединение не установлено · последняя ошибка: CONNECT_FAILED'
  );
});

test('current recovering/auth failures display their safe diagnostic code',()=>{
  assert.equal(
    backgroundConnectionStatusLabel('recovering','BRIDGE_NETWORK_UNREACHABLE'),
    'Восстанавливаем соединение с сервером…: BRIDGE_NETWORK_UNREACHABLE'
  );
  assert.equal(
    backgroundConnectionStatusLabel('auth-failed','BROWSER_KEY_REJECTED_401'),
    'Ошибка авторизации фонового соединения: BROWSER_KEY_REJECTED_401'
  );
});

test('a successful connection does not retain a stale failure',()=>{
  assert.equal(
    backgroundConnectionStatusLabel('connected',null,'OFFSCREEN_UNAVAILABLE'),
    'Подключено · фоновый режим'
  );
});
