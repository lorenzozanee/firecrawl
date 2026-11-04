const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { test } = require('node:test');
const { createBrowserManager } = require('./browser-manager.ts');

class FakeBrowser extends EventEmitter {
  connected = true;

  isConnected() {
    return this.connected;
  }

  disconnect() {
    this.connected = false;
    this.emit('disconnected');
  }
}

test('relaunches a browser after the current browser disconnects', async () => {
  const browsers = [new FakeBrowser(), new FakeBrowser()];
  let launches = 0;
  const manager = createBrowserManager(async () => browsers[launches++]);

  const first = await manager.getBrowser();
  first.disconnect();
  const second = await manager.getBrowser();

  assert.equal(second, browsers[1]);
  assert.equal(launches, 2);
});

test('shares one in-flight launch across concurrent requests', async () => {
  const browser = new FakeBrowser();
  let resolveLaunch;
  let launches = 0;
  const manager = createBrowserManager(
    () =>
      new Promise((resolve) => {
        launches++;
        resolveLaunch = resolve;
      }),
  );

  const first = manager.getBrowser();
  const second = manager.getBrowser();
  await Promise.resolve();
  resolveLaunch(browser);

  assert.equal(await first, browser);
  assert.equal(await second, browser);
  assert.equal(launches, 1);
});

test('a stale browser disconnect does not invalidate its replacement', async () => {
  const browsers = [new FakeBrowser(), new FakeBrowser()];
  let launches = 0;
  const manager = createBrowserManager(async () => browsers[launches++]);
  const first = await manager.getBrowser();
  first.disconnect();
  const second = await manager.getBrowser();

  first.emit('disconnected');

  assert.equal(await manager.getBrowser(), second);
  assert.equal(launches, 2);
});

test('a failed shared launch rejects all waiters and allows another attempt', async () => {
  const browser = new FakeBrowser();
  const failure = new Error('Chromium launch failed');
  let rejectLaunch;
  let launches = 0;
  const manager = createBrowserManager(() => {
    launches++;
    return launches === 1
      ? new Promise((_resolve, reject) => {
          rejectLaunch = reject;
        })
      : Promise.resolve(browser);
  });

  const requests = Array.from({ length: 20 }, () => manager.getBrowser());
  const settled = Promise.allSettled(requests);
  await Promise.resolve();
  assert.equal(launches, 1);
  rejectLaunch(failure);

  for (const result of await settled) {
    assert.equal(result.status, 'rejected');
    assert.equal(result.reason, failure);
  }
  assert.equal(await manager.getBrowser(), browser);
  assert.equal(launches, 2);
});

test('a synchronous launch failure also allows another attempt', async () => {
  const browser = new FakeBrowser();
  const failure = new Error('Invalid launch configuration');
  let launches = 0;
  const manager = createBrowserManager(() => {
    if (++launches === 1) throw failure;
    return Promise.resolve(browser);
  });

  await assert.rejects(manager.getBrowser(), (error) => error === failure);
  assert.equal(await manager.getBrowser(), browser);
  assert.equal(launches, 2);
});

test('detects a disconnected browser even when its event has not arrived', async () => {
  const browsers = [new FakeBrowser(), new FakeBrowser()];
  let launches = 0;
  const manager = createBrowserManager(async () => browsers[launches++]);
  const first = await manager.getBrowser();
  first.connected = false;

  const second = await manager.getBrowser();
  first.emit('disconnected');
  assert.equal(await manager.getBrowser(), second);
  assert.equal(second, browsers[1]);
  assert.equal(launches, 2);
});

test('rejects a browser already disconnected at startup and retries later', async () => {
  const browsers = [new FakeBrowser(), new FakeBrowser()];
  browsers[0].connected = false;
  let launches = 0;
  const manager = createBrowserManager(async () => browsers[launches++]);

  await assert.rejects(manager.getBrowser(), /disconnected during startup/);
  assert.equal(await manager.getBrowser(), browsers[1]);
  assert.equal(launches, 2);
});
