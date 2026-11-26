const SAFE_ERROR_CODE = /^[A-Z][A-Z0-9_:-]{2,120}$/;

export function safeConnectionErrorCode(value) {
  if (typeof value !== 'string') return 'CONNECT_FAILED';
  const code = value.trim();
  return SAFE_ERROR_CODE.test(code) ? code : 'CONNECT_FAILED';
}

const STATE_LABELS = Object.freeze({
  connected: 'Подключено · фоновый режим',
  connecting: 'Фоновое подключение…',
  recovering: 'Восстанавливаем соединение с сервером…',
  'auth-failed': 'Ошибка авторизации фонового соединения',
  disconnected: 'Соединение не установлено'
});

// Keep the last explicit Connect failure visible after the background status
// poll runs. Only stable diagnostic codes are accepted; arbitrary messages,
// response bodies, headers and credentials are never displayed or persisted.
export function backgroundConnectionStatusLabel(state, currentError = null, lastConnectError = null) {
  const label = STATE_LABELS[state] || 'Фоновый режим: ' + String(state || 'unknown');
  if (state === 'disconnected' && lastConnectError) {
    return label + ' · последняя ошибка: ' + safeConnectionErrorCode(lastConnectError);
  }
  if (['recovering', 'auth-failed', 'error'].includes(state) && currentError) {
    return label + ': ' + safeConnectionErrorCode(currentError);
  }
  return label;
}
