import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  deleteAttachment,
  fetchAttachmentReferences,
  renameAttachment,
  resolveAttachment,
} from './attachments';

// 添付ファイル管理API(#199)のfetchモックテスト。api()自体のCSRF/エラー処理は
// api/client.test.tsで検証済みのため、ここではリクエストの組み立てのみを確認する

function stubFetch(status: number, body: unknown) {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(body === undefined ? null : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    }),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('resolveAttachment', () => {
  it('target・fromをクエリに含めてGET /api/attachments/resolveを呼ぶ', async () => {
    const fetchMock = stubFetch(200, { path: 'フォルダ/a.png', name: 'a.png' });
    const result = await resolveAttachment('a.png', 'フォルダ/文書.md');

    expect(result).toEqual({ path: 'フォルダ/a.png', name: 'a.png' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      `/api/attachments/resolve?target=${encodeURIComponent('a.png')}&from=${encodeURIComponent('フォルダ/文書.md')}`,
    );
    expect(init.method).toBe('GET');
  });
});

describe('fetchAttachmentReferences', () => {
  it('pathをクエリに含めてGET /api/attachments/referencesを呼ぶ', async () => {
    const fetchMock = stubFetch(200, { docs: ['a.md', 'b.md'] });
    const result = await fetchAttachmentReferences('フォルダ/a.png');

    expect(result).toEqual({ docs: ['a.md', 'b.md'] });
    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe(`/api/attachments/references?path=${encodeURIComponent('フォルダ/a.png')}`);
  });
});

describe('renameAttachment', () => {
  it('bodyをJSONでPOST /api/attachments/renameへ送る', async () => {
    const fetchMock = stubFetch(200, {
      path: 'フォルダ/b.png',
      name: 'b.png',
      rewrittenDocs: [{ path: '文書.md', updatedAt: '2026-08-23T00:00:00+09:00' }],
    });
    const result = await renameAttachment({ path: 'フォルダ/a.png', newName: 'b.png' });

    expect(result.name).toBe('b.png');
    expect(result.rewrittenDocs).toEqual([
      { path: '文書.md', updatedAt: '2026-08-23T00:00:00+09:00' },
    ]);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/attachments/rename');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ path: 'フォルダ/a.png', newName: 'b.png' });
  });
});

describe('deleteAttachment', () => {
  it('pathをクエリに含めてDELETE /api/attachmentsを呼ぶ', async () => {
    const fetchMock = stubFetch(200, { ok: true });
    await deleteAttachment('フォルダ/a.png');

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`/api/attachments?path=${encodeURIComponent('フォルダ/a.png')}`);
    expect(init.method).toBe('DELETE');
  });
});
