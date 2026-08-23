// embed-view/image-view(NodeView)が相対パス・添付索引解決に使う、現在開いている
// 文書の情報を editor.storage.tsumiwikiDoc に持たせるための共通型(#198)。
// 設定側はDocView.tsx、参照側はeditor/extensions/embed-view.tsx・image-view.tsx
//
// openAttachmentMenu(#199): NodeView側で右クリック/「⋯」ボタン操作を検知したときに
// DocViewへ「この添付のメニューを開いてほしい」と伝える橋渡し。NodeViewはeditor.storage
// 経由でしかDocViewの状態にアクセスできないため、関数そのものをstorageに載せる

export interface AttachmentMenuRequest {
  // ![[...]]のfile部分(parseEmbedTarget後、サイズ/anchor/別名を含まない)、
  // または![](src)のsrc(そのまま)
  target: string;
  kind: 'embed' | 'image';
  // クリック/右クリック位置(clientX/Y)。ContextMenuの表示位置に使う
  x: number;
  y: number;
}

export interface TsumiwikiDocStorage {
  folder?: string;
  path?: string;
  openAttachmentMenu?: (req: AttachmentMenuRequest) => void;
}
