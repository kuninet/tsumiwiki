// embed-view/image-view(NodeView)が相対パス・添付索引解決に使う、現在開いている
// 文書の情報を editor.storage.tsumiwikiDoc に持たせるための共通型(#198)。
// 設定側はDocView.tsx、参照側はeditor/extensions/embed-view.tsx・image-view.tsx
//
// openAttachmentMenu(#199): NodeView側で右クリック/「⋯」ボタン操作を検知したときに
// DocViewへ「この添付のメニューを開いてほしい」と伝える橋渡し。NodeViewはeditor.storage
// 経由でしかDocViewの状態にアクセスできないため、関数そのものをstorageに載せる
//
// openAttachmentLightbox(#211): 画像クリック/PDFの「拡大表示」メニューで
// DocView側にライトボックス表示を依頼する橋渡し。srcは呼び出し側(NodeViewまたはDocView)が
// embedSrc/resolveImageSrc/toFilesUrl等で解決済みのURLを渡す

export interface AttachmentMenuRequest {
  // ![[...]]のfile部分(parseEmbedTarget後、サイズ/anchor/別名を含まない)、
  // または![](src)のsrc(そのまま)
  target: string;
  kind: 'embed' | 'image';
  // #211: PDFの拡大表示でsrcのfragmentとして引き継ぐanchor(`#page=3`など)。
  // 埋め込みiframeと拡大iframeでページが揃うようにする(レビュー重大#5)
  anchor?: string;
  // クリック/右クリック位置(clientX/Y)。ContextMenuの表示位置に使う
  x: number;
  y: number;
}

export interface AttachmentLightboxRequest {
  kind: 'image' | 'pdf';
  src: string;
  alt?: string;
}

export interface TsumiwikiDocStorage {
  folder?: string;
  path?: string;
  openAttachmentMenu?: (req: AttachmentMenuRequest) => void;
  openAttachmentLightbox?: (req: AttachmentLightboxRequest) => void;
}
