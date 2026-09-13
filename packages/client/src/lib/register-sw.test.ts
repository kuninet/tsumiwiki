import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerServiceWorker } from './register-sw';

// Service Workerの登録・更新検知(#251)。
// jsdomにはService Workerが無いため、navigator.serviceWorker を差し替えて検証する

/** 更新可能になったworkerの代役。postMessageの中身を確認する */
class FakeWorker extends EventTarget {
  state: ServiceWorker['state'] = 'installing';
  messages: unknown[] = [];
  postMessage(data: unknown) {
    this.messages.push(data);
  }
  setState(state: ServiceWorker['state']) {
    this.state = state;
    this.dispatchEvent(new Event('statechange'));
  }
}

class FakeRegistration extends EventTarget {
  installing: FakeWorker | null = null;
  waiting: FakeWorker | null = null;
}

class FakeContainer extends EventTarget {
  controller: unknown = null;
  registration = new FakeRegistration();
  registerCalls: Array<[string, unknown]> = [];
  register(url: string, options?: unknown) {
    this.registerCalls.push([url, options]);
    return Promise.resolve(this.registration);
  }
}

function installFakeContainer(): FakeContainer {
  const container = new FakeContainer();
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: container,
  });
  return container;
}

function stubReload(): { calls: number } {
  const counter = { calls: 0 };
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...window.location, reload: () => (counter.calls += 1) },
  });
  return counter;
}

afterEach(() => {
  // @ts-expect-error テスト用に差し込んだプロパティを外す
  delete navigator.serviceWorker;
  vi.restoreAllMocks();
});

describe('registerServiceWorker', () => {
  it('Service Worker非対応の環境では何もしない', () => {
    // @ts-expect-error 非対応環境の再現
    delete navigator.serviceWorker;
    const onUpdateReady = vi.fn();
    expect(() => registerServiceWorker(onUpdateReady)).not.toThrow();
    expect(onUpdateReady).not.toHaveBeenCalled();
  });

  it('ルートスコープで /sw.js を登録する', async () => {
    const container = installFakeContainer();
    registerServiceWorker(vi.fn());
    await Promise.resolve();
    expect(container.registerCalls).toEqual([['/sw.js', { scope: '/' }]]);
  });

  it('初回インストール(controllerが居ない)では更新通知を出さない', async () => {
    const container = installFakeContainer();
    const onUpdateReady = vi.fn();
    registerServiceWorker(onUpdateReady);
    await Promise.resolve();

    const installing = new FakeWorker();
    container.registration.installing = installing;
    container.registration.dispatchEvent(new Event('updatefound'));
    installing.setState('installed');

    expect(onUpdateReady).not.toHaveBeenCalled();
  });

  it('更新が入ると通知し、承諾でskipWaitingを促してリロードする', async () => {
    const container = installFakeContainer();
    container.controller = {}; // 既存のSWが制御中=更新である
    const reload = stubReload();
    const onUpdateReady = vi.fn();
    registerServiceWorker(onUpdateReady);
    await Promise.resolve();

    const installing = new FakeWorker();
    container.registration.installing = installing;
    container.registration.dispatchEvent(new Event('updatefound'));
    installing.setState('installed');

    expect(onUpdateReady).toHaveBeenCalledTimes(1);
    // 承諾前に勝手にskipWaitingしない(編集中のタブを無警告で置き換えないため)
    expect(installing.messages).toEqual([]);

    // controllerchangeだけでは(承諾前なので)リロードしない
    container.dispatchEvent(new Event('controllerchange'));
    expect(reload.calls).toBe(0);

    const applyUpdate = onUpdateReady.mock.calls[0][0] as () => void;
    applyUpdate();
    expect(installing.messages).toEqual([{ type: 'SKIP_WAITING' }]);

    container.dispatchEvent(new Event('controllerchange'));
    expect(reload.calls).toBe(1);

    // 二重リロードしない
    container.dispatchEvent(new Event('controllerchange'));
    expect(reload.calls).toBe(1);
  });

  it('前回見送った更新が待機中なら、登録直後に通知する', async () => {
    const container = installFakeContainer();
    container.controller = {};
    const waiting = new FakeWorker();
    waiting.state = 'installed';
    container.registration.waiting = waiting;
    const onUpdateReady = vi.fn();

    registerServiceWorker(onUpdateReady);
    await Promise.resolve();
    await Promise.resolve();

    expect(onUpdateReady).toHaveBeenCalledTimes(1);
    const applyUpdate = onUpdateReady.mock.calls[0][0] as () => void;
    applyUpdate();
    expect(waiting.messages).toEqual([{ type: 'SKIP_WAITING' }]);
  });
});
