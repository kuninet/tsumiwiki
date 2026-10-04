// [[target]] の解決(設計05章 / issue #266)。
// 実装は @tsumiwiki/shared に集約され、クライアントとサーバーで同一の解決規則を共有する。
export { buildWikilinkResolver, parseWikilinkTarget, resolveWikilink } from '@tsumiwiki/shared';
