// embed-view/image-view(NodeView)が相対パス・添付索引解決に使う、現在開いている
// 文書の情報を editor.storage.tsumiwikiDoc に持たせるための共通型(#198)。
// 設定側はDocView.tsx、参照側はeditor/extensions/embed-view.tsx・image-view.tsx

export interface TsumiwikiDocStorage {
  folder?: string;
  path?: string;
}
