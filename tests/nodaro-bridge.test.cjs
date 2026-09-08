const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { test } = require('node:test');
const { runInNewContext } = require('node:vm');

const bridge = readFileSync(require.resolve('../src/nodaro-bridge.js'), 'utf8');

function openBridge(origin) {
  const sent = [];
  let receive;
  const parent = { postMessage: (message, target) => sent.push({ message, target }) };
  const window = {
    top: parent, parent,
    addEventListener: (type, callback) => { if (type === 'message') receive = callback; },
  };
  window.self = window;
  const document = {
    referrer: origin + '/editor',
    createElement: () => ({ click() {} }),
    getElementById: () => null,
    getElementsByTagName: () => [],
    querySelectorAll: () => [],
    body: { innerText: '' },
  };
  runInNewContext(bridge, { window, document, URL, setTimeout() {} });
  receive({ origin, source: parent, data: { type: 'NODARO_DIAGNOSTICS' } });
  return sent;
}

for (const origin of ['https://studio.nodaro.ai', 'https://next.studio.nodaro.ai',
  'https://app.nodaro.ai', 'https://next.nodaro.ai']) {
  test('accepts editor messages from ' + origin, () => {
    const sent = openBridge(origin);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].message.type, 'AUDIOMASS_DIAGNOSTICS');
    assert.equal(sent[0].target, origin);
  });
}

for (const origin of ['https://next.studio.nodaro.ai.evil.example',
  'http://next.studio.nodaro.ai', 'https://evil.example']) {
  test('ignores editor messages from ' + origin, () => {
    assert.equal(openBridge(origin).length, 0);
  });
}
