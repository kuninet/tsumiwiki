import { describe, expect, it } from 'vitest';
import { collectMcpAddresses, isAllowedMcpAddress, isBrowserRequest } from './mcp-network.js';

describe('isAllowedMcpAddress', () => {
  it.each([
    '127.0.0.1',
    '::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '100.64.0.1',
    '100.127.255.255',
    '169.254.1.1',
    'fd7a:115c:a1e0::1',
    'fe80::1',
    'fe80::1%en0',
    '::ffff:192.168.0.5',
  ])('%s は許可', (ip) => {
    expect(isAllowedMcpAddress(ip)).toBe(true);
  });

  it.each([
    '8.8.8.8',
    '172.32.0.1',
    '172.15.255.255',
    '100.128.0.1',
    '100.63.255.255',
    '2001:db8::1',
    '::ffff:8.8.8.8',
    '::ffff:808:808',
    '::',
    '',
    'unknown',
    'abc',
    '_hidden',
    '127.0.0.1:8080',
  ])('%s は不許可', (ip) => {
    expect(isAllowedMcpAddress(ip)).toBe(false);
  });
});

describe('collectMcpAddresses', () => {
  const socket = { remoteAddress: '127.0.0.1' };

  it('ソケットのアドレスのみ', () => {
    expect(collectMcpAddresses({ socket, headers: {} })).toEqual(['127.0.0.1']);
  });

  it('X-Forwarded-For は全エントリを取り出す', () => {
    const addrs = collectMcpAddresses({
      socket,
      headers: { 'x-forwarded-for': '203.0.113.5, 10.0.0.1 ,100.101.1.1' },
    });
    expect(addrs).toEqual(['127.0.0.1', '203.0.113.5', '10.0.0.1', '100.101.1.1']);
  });

  it('Forwarded の for= から引用符・ブラケット・ポートを剥がす', () => {
    const addrs = collectMcpAddresses({
      socket,
      headers: {
        forwarded:
          'for=192.0.2.43:4711, for="[2001:db8:cafe::17]:4711";proto=http;by=203.0.113.43, For=unknown, for=_hidden',
      },
    });
    expect(addrs).toEqual([
      '127.0.0.1',
      '192.0.2.43',
      '2001:db8:cafe::17',
      'unknown',
      '_hidden',
    ]);
  });

  it('X-Real-IP / CF-Connecting-IP / True-Client-IP も含める', () => {
    const addrs = collectMcpAddresses({
      socket,
      headers: {
        'x-real-ip': '1.1.1.1',
        'cf-connecting-ip': '2.2.2.2',
        'true-client-ip': '3.3.3.3',
      },
    });
    expect(addrs).toEqual(['127.0.0.1', '1.1.1.1', '2.2.2.2', '3.3.3.3']);
  });

  it('remoteAddress が無いときは空文字(不許可)を含める', () => {
    expect(collectMcpAddresses({ socket: {}, headers: {} })).toEqual(['']);
  });
});

describe('isBrowserRequest', () => {
  it('Origin / Sec-Fetch-* のいずれかがあればブラウザ発', () => {
    expect(isBrowserRequest({ origin: 'http://evil.example' })).toBe(true);
    expect(isBrowserRequest({ 'sec-fetch-site': 'same-origin' })).toBe(true);
    expect(isBrowserRequest({ 'sec-fetch-mode': 'cors' })).toBe(true);
    expect(isBrowserRequest({ 'sec-fetch-dest': 'empty' })).toBe(true);
  });

  it('どれも無ければ非ブラウザ', () => {
    expect(isBrowserRequest({ 'user-agent': 'claude-code' })).toBe(false);
  });
});
