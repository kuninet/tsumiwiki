import { BlockList, isIP } from 'node:net';
import type { FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';

// MCP_AUTH=none(認証なしモード、issue #290)用の送信元制限。
// ローカル・LAN・Tailscale のアドレスだけを許可し、公開されたときの被害を防ぐ

const allowed = new BlockList();
// IPv4
allowed.addSubnet('127.0.0.0', 8, 'ipv4'); // ループバック
allowed.addSubnet('10.0.0.0', 8, 'ipv4'); // プライベート
allowed.addSubnet('172.16.0.0', 12, 'ipv4'); // プライベート
allowed.addSubnet('192.168.0.0', 16, 'ipv4'); // プライベート
allowed.addSubnet('100.64.0.0', 10, 'ipv4'); // CGNAT(Tailscale)
allowed.addSubnet('169.254.0.0', 16, 'ipv4'); // リンクローカル
// IPv6
allowed.addAddress('::1', 'ipv6'); // ループバック
allowed.addSubnet('fc00::', 7, 'ipv6'); // ULA(Tailscaleの fd7a:115c:a1e0::/48 を含む)
allowed.addSubnet('fe80::', 10, 'ipv6'); // リンクローカル

// IPv4-mapped IPv6(::ffff:a.b.c.d / ::ffff:xxxx:xxxx)はIPv4アドレスに直す
function unmapIpv4(ip: string): string {
  const dotted = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (dotted) return dotted[1];
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(ip);
  if (hex) {
    const high = parseInt(hex[1], 16);
    const low = parseInt(hex[2], 16);
    return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
  }
  return ip;
}

/** 許可レンジ(ローカル・LAN・Tailscale)のアドレスかどうか。パースできない文字列は不許可 */
export function isAllowedMcpAddress(ip: string): boolean {
  // IPv6のゾーンID(fe80::1%en0)は判定に使わないので除く
  const normalized = unmapIpv4(ip.trim().replace(/%.*$/, ''));
  const family = isIP(normalized);
  if (family === 4) return allowed.check(normalized, 'ipv4');
  if (family === 6) return allowed.check(normalized, 'ipv6');
  return false;
}

function headerValues(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

// Forwarded ヘッダーの for= 値から引用符・[ipv6]・:port を剥がす。
// unknown や難読化識別子(_xxx)はそのまま残り、isAllowedMcpAddress で不許可になる
function parseForwardedFor(value: string): string {
  let v = value.trim();
  if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) v = v.slice(1, -1).trim();
  const bracket = /^\[([^\]]*)\](?::[^:]*)?$/.exec(v);
  if (bracket) return bracket[1];
  const ipv4WithPort = /^(\d{1,3}(?:\.\d{1,3}){3}):[^:]*$/.exec(v);
  if (ipv4WithPort) return ipv4WithPort[1];
  return v;
}

/**
 * 検査対象のアドレス群を返す。ソケットの送信元に加え、同一ホスト上のリバースプロキシ・トンネル
 * (Cloudflare Tunnel / Caddy / Tailscale Funnel 等)経由だとソケットが127.0.0.1になるため、
 * 転送ヘッダーが示す元の送信元も全て含める
 */
export function collectMcpAddresses(req: {
  socket: { remoteAddress?: string };
  headers: Record<string, string | string[] | undefined>;
}): string[] {
  const addresses: string[] = [req.socket.remoteAddress ?? ''];
  for (const line of headerValues(req.headers['x-forwarded-for'])) {
    for (const entry of line.split(',')) addresses.push(entry.trim());
  }
  for (const line of headerValues(req.headers['forwarded'])) {
    for (const element of line.split(',')) {
      for (const pair of element.split(';')) {
        const eq = pair.indexOf('=');
        if (eq < 0) continue;
        if (pair.slice(0, eq).trim().toLowerCase() !== 'for') continue;
        addresses.push(parseForwardedFor(pair.slice(eq + 1)));
      }
    }
  }
  for (const name of ['x-real-ip', 'cf-connecting-ip', 'true-client-ip']) {
    for (const value of headerValues(req.headers[name])) addresses.push(value.trim());
  }
  return addresses;
}

/**
 * ブラウザ発のリクエストかどうか。DNS リバインディングで LAN 内のブラウザから叩かれるのを防ぐ
 * (MCP の Streamable HTTP 仕様は Origin の検証を求めている)。
 * Claude Code / Desktop などの非ブラウザクライアントは Origin / Sec-Fetch-* を送らない
 */
export function isBrowserRequest(headers: Record<string, string | string[] | undefined>): boolean {
  return ['origin', 'sec-fetch-site', 'sec-fetch-mode', 'sec-fetch-dest'].some(
    (name) => headers[name] !== undefined,
  );
}

export const mcpNetworkPlugin = fp(async (app) => {
  // このプラグインは/mcpだけを持つカプセル化コンテキストに張られるため無条件で検査する。
  // 生URLの文字列比較によるパス判定はパーセントエンコード(/%6dcp等)で素通りするので行わない
  app.addHook('preHandler', async (req: FastifyRequest, reply: FastifyReply) => {
    if (isBrowserRequest(req.headers)) {
      req.log.warn(
        { origin: req.headers.origin, secFetchSite: req.headers['sec-fetch-site'] },
        'MCP 認証なしモード: ブラウザからのリクエストを拒否しました',
      );
      reply.code(403).send({
        error: {
          code: 'FORBIDDEN',
          message: '認証なしモードではブラウザからの接続は受け付けません',
        },
      });
      return;
    }
    const addresses = collectMcpAddresses(req);
    if (addresses.every(isAllowedMcpAddress)) return;
    req.log.warn({ addresses }, 'MCP 認証なしモード: 許可外の送信元を拒否しました');
    reply.code(403).send({
      error: {
        code: 'FORBIDDEN',
        message: '認証なしモードではローカル・LAN・Tailscale からの接続のみ受け付けます',
      },
    });
  });
});
