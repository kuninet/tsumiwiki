import { useQueryClient } from '@tanstack/react-query';
import { EditorContent, useEditor } from '@tiptap/react';
import { CURSOR_MARKER, type DocResponse, type DocSummary, type User } from '@tsumiwiki/shared';
import {
  type ChangeEvent as ReactChangeEvent,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useNavigate } from 'react-router-dom';
import {
  deleteAttachment,
  fetchAttachmentReferences,
  renameAttachment,
  resolveAttachment,
  uploadAttachment,
} from '../api/attachments';
import { ApiRequestError } from '../api/client';
import { isAllowedLinkUrl } from '../lib/allowed-link';
import { docQueryKey, useTree } from '../api/docs';
import { useExpandTemplate } from '../api/templates';
import type { AttachmentLightboxRequest, AttachmentMenuRequest } from '../editor/doc-storage';
import { createEditorExtensions } from '../editor/markdown';
import { parseMarkdownFragment } from '../editor/parse-fragment';
import { getTableMenuItems } from '../editor/table-menu';
import { findTableAt } from '../editor/table-utils';
import '../editor/editor.css';
import { useEditingSession } from '../hooks/use-editing-session';
import { useVirtualKeyboard } from '../hooks/use-virtual-keyboard';
import { dispatchAttachmentChanged } from '../lib/attachment-events';
import { titleFromPath } from '../lib/doc-path';
import { handleWikilinkClick } from '../lib/handle-wikilink-click';
import { removeInlineTag, renameInlineTag } from '../lib/inline-tag-rewrite';
import { isPdfFile, parseEmbedTarget, toFilesUrl } from '../lib/resolve-embed-src';
import { saveBadge } from '../lib/save-badge';
import { registerTabActions } from '../lib/tab-actions-registry';
import { useEditStore } from '../stores/edit';
import { useToastStore } from '../stores/toast';
import { useUIStore } from '../stores/ui';
import { contentWidthMaxClass, useUserSettingsStore } from '../stores/user-settings';
import { AttachmentLightbox } from './AttachmentLightbox';
import { ConfirmDialog } from './ConfirmDialog';
import { ContextMenu } from './ContextMenu';
import { EditorToolbar } from './EditorToolbar';
import { HistoryPanel } from './HistoryPanel';
import { PromptDialog } from './PromptDialog';
import { TagChipEditor } from './TagChipEditor';
import { TemplatePickerDialog } from './TemplatePickerDialog';

// 文書閲覧・編集画面(SC-02のMainPane。設計04章4.2/4.4・05章5.3〜5.6・デザインhandoff components.md)
// 閲覧・編集は同じTiptapインスタンスのeditable切り替えで実現し、表示を完全一致させる

interface DocViewProps {
  doc: DocResponse;
  currentUser: User;
  // Epic #133 タブ導入: 非アクティブタブは表示上は hidden で、useEditStore への書き込みや
  // ロック取得の自動起動を抑止する。dirty 状態はタブバー側に反映するためコールバックで通知する。
  // 省略時は active=true 互換(直接 DocView を使うテストや demo で従来通り動く)
  active?: boolean;
  onDirtyChange?: (dirty: boolean) => void;
  // このタブの mode を親(DocTab)に返す。useDoc の refetchInterval を「自分のタブ mode」に
  // 基づかせるために使う(グローバル useEditStore.mode は active タブのモードなので
  // 背景 edit タブが誤って refetch されるのを防ぐ)
  onModeChange?: (mode: 'view' | 'edit') => void;
}

function folderOfPath(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx === -1 ? '' : path.slice(0, idx);
}

// パンくず用: フォルダ階層のセグメント一覧(ファイル名は含まない)
function breadcrumbFromPath(path: string): string[] {
  const folder = folderOfPath(path);
  return folder ? folder.split('/') : [];
}

// 更新日時をJSTの「日付」と「時刻」に分けて返す。
// 想定入力: ISO 8601(サーバーはUTCで送出)。パース失敗時は原文をdateへ、timeは空
function formatUpdatedAt(iso: string): { date: string; time: string } {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return { date: iso, time: '' };
  const tz = 'Asia/Tokyo';
  const date = new Intl.DateTimeFormat('ja-JP', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
  const time = new Intl.DateTimeFormat('ja-JP', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(d);
  return { date, time };
}

// D&D/ペーストで受け付けるファイル種別(画像 + PDF。FR-IMG-01/04)
function isAttachmentFile(f: File): boolean {
  return f.type.startsWith('image/') || f.type === 'application/pdf';
}

// #199 添付リネーム: サーバーが返す replacements(その文書で実際に書き換えた
// target→新target。trim済み・`|alias`・`#anchor`・`?query`・`"title"`を含まない)を
// そのままエディタ内ノードにも適用するためのヘルパー(純関数)。
// Opusレビュー重大1: 以前はbasename一致(大文字小文字無視)の単純な規則で書き換えていたが、
// 同名で別実体(別フォルダ等)の添付まで誤って書き換えてしまうバグがあった。
// サーバーが「この文書で実際に書き換えた対応」を返すようになったため、それに厳密一致した
// ノードだけを書き換える(一致しないノードには一切触れない)

// `![[ old.png |300]]` のfile部分(from・trim済み)をtoに置き換える。
// file前後の空白・`#anchor`・`|サイズ or 別名` はそのまま保持する
function rewriteEmbedTargetFile(target: string, to: string): string {
  const pipeIdx = target.indexOf('|');
  const rawFile = pipeIdx === -1 ? target : target.slice(0, pipeIdx);
  const pipePart = pipeIdx === -1 ? '' : target.slice(pipeIdx); // '|'込み
  const hashIdx = rawFile.indexOf('#');
  const fileWithoutAnchor = hashIdx === -1 ? rawFile : rawFile.slice(0, hashIdx);
  const anchorPart = hashIdx === -1 ? '' : rawFile.slice(hashIdx); // '#'込み
  const leadingWs = /^\s*/.exec(fileWithoutAnchor)?.[0] ?? '';
  const trailingWs = /\s*$/.exec(fileWithoutAnchor)?.[0] ?? '';
  return `${leadingWs}${to}${trailingWs}${anchorPart}${pipePart}`;
}

// `![alt](sub/old.png "title")` のsrc部分(from。`?query`・`#anchor`を含む場合はそこまで)を
// toに置き換える。`?query`・`#anchor` はそのまま保持する("title" はProseMirror側で
// 別属性(node.attrs.title)に分離されているためsrcには含まれない)
function rewriteImageSrcFile(src: string, to: string): string {
  const hashOrQueryIdx = src.search(/[?#]/);
  const suffix = hashOrQueryIdx === -1 ? '' : src.slice(hashOrQueryIdx);
  return `${to}${suffix}`;
}

// `[[ old.png ]]`/`[[old.png#anchor|別名]]` のtarget属性(from・trim済み)をtoに置き換える。
// 前後の空白・`#anchor` はそのまま保持する(別名はalias属性に分離されておりtargetには含まれない)
function rewriteWikilinkTargetFile(target: string, to: string): string {
  const hashOrQueryIdx = target.search(/[?#]/);
  const base = hashOrQueryIdx === -1 ? target : target.slice(0, hashOrQueryIdx);
  const suffix = hashOrQueryIdx === -1 ? '' : target.slice(hashOrQueryIdx);
  const leadingWs = /^\s*/.exec(base)?.[0] ?? '';
  const trailingWs = /\s*$/.exec(base)?.[0] ?? '';
  return `${leadingWs}${to}${trailingWs}${suffix}`;
}

// `[説明](old.png "title")` のhref(from。`?query`・`#anchor`を含む場合はそこまで)をtoに置き換える。
// `?query`・`#anchor` はそのまま保持する
function rewriteLinkHrefFile(href: string, to: string): string {
  const hashOrQueryIdx = href.search(/[?#]/);
  const suffix = hashOrQueryIdx === -1 ? '' : href.slice(hashOrQueryIdx);
  return `${to}${suffix}`;
}

export function DocView({
  doc,
  currentUser,
  active = true,
  onDirtyChange,
  onModeChange,
}: DocViewProps) {
  const [linkDialogVisible, setLinkDialogVisible] = useState(false);
  const [historyVisible, setHistoryVisible] = useState(false);
  const [discardConfirmVisible, setDiscardConfirmVisible] = useState(false);
  const [templateApplyOpen, setTemplateApplyOpen] = useState(false);
  // #51 Opus C1: タグの pending 状態を DocView 側に持ち、連続タグ操作でも
  // stale な doc.tags を参照しないようにする。閲覧モード遷移で doc.tags 側へ揃える
  const [pendingTags, setPendingTags] = useState<string[]>(doc.tags);
  // #199 画像の管理メニュー: 右クリック/「⋯」ボタンで開く。resolveAttachment成功後にのみセットする
  // (未解決の間はメニューを出さずトーストのみ表示するため、resolvedは必須にしている)
  const [attachmentMenu, setAttachmentMenu] = useState<
    (AttachmentMenuRequest & { resolved: { path: string; name: string } }) | null
  >(null);
  // #211: 画像クリック/PDFの「拡大表示」メニューで開くライトボックスの表示状態
  const [lightbox, setLightbox] = useState<AttachmentLightboxRequest | null>(null);
  // #222 表のコンテキストメニュー: 右クリック位置(表内のときだけセットする)
  const [tableMenu, setTableMenu] = useState<{ x: number; y: number } | null>(null);
  // #224 ソース編集モード: 編集モード中に限り、WYSIWYG(Tiptap)ではなくMarkdown原文を
  // textareaで直接編集できるようにする。グローバルなsession.mode('view'/'edit')は変えず、
  // 「editモードの表示形態」としてDocViewローカルで持つ(タブ複製・分割ペインでも独立に動く)
  const [sourceMode, setSourceMode] = useState(false);
  const [sourceText, setSourceText] = useState('');
  const [renameDialog, setRenameDialog] = useState<{
    resolved: { path: string; name: string };
  } | null>(null);
  // referenceDocs: null は「参照文書を確認中」(中#7: 確認ダイアログは先に出し、
  // 取得できたら本文と確定ボタンの有効化を追随させる)
  const [deleteDialog, setDeleteDialog] = useState<{
    resolved: { path: string; name: string };
    referenceDocs: string[] | null;
  } | null>(null);

  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const showToast = useToastStore((s) => s.show);
  const expandTemplate = useExpandTemplate();
  const setLockedByOtherName = useEditStore((s) => s.setLockedByOtherName);
  const setSidebarTab = useUIStore((s) => s.setSidebarTab);
  const toggleTag = useUIStore((s) => s.toggleTag);
  const editorChromeVisible = useUIStore((s) => s.editorChromeVisible);
  const showEditorChrome = useUIStore((s) => s.showEditorChrome);
  const resetEditorChrome = useUIStore((s) => s.resetEditorChrome);
  // #212: 本文最大幅の個人設定(normal/wide/full)。編集/閲覧共通
  const contentWidth = useUserSettingsStore((s) => s.contentWidth);
  // #175: 仮想キーボード出現時に scroll 領域下端へ空ける px 数
  const { bottomOffset: keyboardBottomOffset } = useVirtualKeyboard();
  const { data: tree } = useTree();

  const wikilinkDocsRef = useRef<DocSummary[]>([]);
  useEffect(() => {
    wikilinkDocsRef.current = tree?.docs ?? [];
  }, [tree]);

  const session = useEditingSession({
    path: doc.path,
    baseUpdatedAt: doc.updatedAt,
    active,
  });

  // Phase A-2: タブ閉じ時に save/discard を DocView 外(CloseConfirmDialog)から
  // 呼べるようレジストリに登録する。session の save/cancelEditing は useCallback で
  // ラップされていて安定参照。edit モードのときだけ登録することで、view モードの
  // タブに対して save 等を呼び出さないようにする(Opus レビュー M1 対応)
  useEffect(() => {
    if (session.mode !== 'edit') return;
    const unregister = registerTabActions(doc.path, {
      save: () => session.save(),
      discard: () => session.cancelEditing(),
    });
    return unregister;
  }, [doc.path, session.mode, session.save, session.cancelEditing]);

  // タブバー側の dirty 表示(●)と DocTab 側の tab mode を追随させる。
  // 初回マウントの通知はスキップする(M2): 再遷移して DocView が新規マウントされたとき、
  // 前回の tab.dirty=true(下書きあり) を初期の session.dirty=false で誤消去しないため。
  // 以降は実際の変化のみを通知する
  const initialDirtyReportedRef = useRef(false);
  useEffect(() => {
    if (!initialDirtyReportedRef.current) {
      initialDirtyReportedRef.current = true;
      return;
    }
    onDirtyChange?.(session.dirty);
  }, [session.dirty, onDirtyChange]);
  useEffect(() => {
    onModeChange?.(session.mode);
  }, [session.mode, onModeChange]);

  // 拡張群はマウント時に1度だけ構築する(毎レンダーのsetOptions再設定を回避)
  const extensions = useMemo(
    () => createEditorExtensions({ getWikilinkDocs: () => wikilinkDocsRef.current }),
    // wikilinkDocsRefはref経由のため再構築不要
    [],
  );
  // NodeView(embed-view/image-view)が画像解決に使う現在文書の情報。
  // useEditor のオプションは生成時に固定されるため ref 経由で最新の doc.path を参照する
  const docPathRef = useRef(doc.path);
  docPathRef.current = doc.path;
  // #199: NodeViewからのメニュー起動要求を受け取る関数。editor.storageに載せるのは
  // 生成時に固定される安定した関数(下のuseRef経由ラッパー)にし、実処理は
  // handleOpenAttachmentMenuRef.currentで常に最新のクロージャを参照する
  // (sessionRef等、このファイルの他のref経由参照と同じ方式)
  const handleOpenAttachmentMenuRef = useRef<(req: AttachmentMenuRequest) => void>(() => {});
  const openAttachmentMenu = useRef((req: AttachmentMenuRequest) => {
    handleOpenAttachmentMenuRef.current(req);
  }).current;
  // #211: setLightbox(useStateのセッター)は常に同一参照のため、openAttachmentMenuのような
  // ref経由の間接呼び出しは不要で直接ラップするだけでNodeViewに渡せる安定参照になる
  const openAttachmentLightbox = useRef((req: AttachmentLightboxRequest) => {
    setLightbox(req);
  }).current;
  // 添付リネームでエディタ内ノードをプログラム的に書き換えるとき、その1回だけ
  // onUpdate→session.updateBody(dirty化)を抑止するフラグ。既にサーバー側でファイルを
  // 書き換え済みのため、この置換自体はユーザーの未保存編集として扱わない
  const suppressNextUpdateRef = useRef(false);
  const editor = useEditor({
    extensions,
    content: doc.body,
    editable: false,
    // NodeView の初回描画(ビュー生成時)より前に storage を用意しておく。
    // 後続の useEffect だけだと初回描画が folder/path 未設定で走り、
    // /api/embed への問い合わせが from='' になってしまう
    onBeforeCreate: ({ editor: e }) => {
      e.storage.tsumiwikiDoc = {
        folder: folderOfPath(docPathRef.current),
        path: docPathRef.current,
        openAttachmentMenu,
        openAttachmentLightbox,
      };
    },
    onUpdate: ({ editor: e }) => {
      const markdown = e.storage.markdown.getMarkdown() as string;
      if (suppressNextUpdateRef.current) {
        // 添付リネームによる参照書き換え: サーバー側で既にファイルが書き換わっているため
        // dirty にはせず、保存対象の本文だけ追随させる(未保存編集中でも旧名が保存されない)
        suppressNextUpdateRef.current = false;
        session.syncBody(markdown);
        return;
      }
      session.updateBody(markdown);
    },
    editorProps: {
      // iPadOS Safari の外部キーボードでは IME 変換中の Space も keydown として
      // JS に届く。ProseMirror にそのまま処理させると内部で preventDefault され、
      // WebKit の IME 候補送りが奪われるため、変換中の Space だけ PM の既定ハンドラを
      // バイパスして WebKit の IME に処理を委ねる(composition の text 反映は beforeinput
      // 経由なのでそちらは触らない)
      handleDOMEvents: {
        keydown: (_view, event) => event.isComposing && event.key === ' ',
        // #222 表のコンテキストメニュー: 表内での右クリックだけ乗っ取り、それ以外はブラウザ標準メニューに任せる
        contextmenu: (view, event) => {
          if (!view.editable) return false;
          // キーボード起動(メニューキー/Shift+F10)はclientX/Yが0で座標が使えないため、
          // 現在のカーソル位置で判定し、メニューもカーソル座標に出す。
          // この経路はsetTextSelectionを呼ばず、現在の選択(CellSelection含む)をそのまま操作対象にする
          if (event.clientX === 0 && event.clientY === 0) {
            const { $from } = view.state.selection;
            if (!findTableAt($from)) return false;
            const cursor = view.coordsAtPos(view.state.selection.from);
            event.preventDefault();
            // ContextMenuはwindowのcontextmenuで自身を閉じるため、開いた同じイベントが
            // windowまで昇って即closeしないよう伝播を止める(実機Chromiumで確認した挙動)
            event.stopPropagation();
            setTableMenu({ x: cursor.left, y: cursor.bottom });
            return true;
          }
          const coords = view.posAtCoords({ left: event.clientX, top: event.clientY });
          if (!coords) return false;
          if (!findTableAt(view.state.doc.resolve(coords.pos))) return false;
          // 右クリックはカーソルを移動しないブラウザがあるため、判定・操作対象を確実にするため
          // クリック位置へselectionを合わせてからメニューを開く
          editor?.commands.setTextSelection(coords.pos);
          event.preventDefault();
          // 同上: 同一イベントのwindowバブルによる即closeを防ぐ
          event.stopPropagation();
          setTableMenu({ x: event.clientX, y: event.clientY });
          return true;
        },
      },
      handleDrop: (_view, event) => {
        const files = Array.from(event.dataTransfer?.files ?? []).filter(isAttachmentFile);
        if (files.length === 0) return false;
        event.preventDefault();
        void handleUploadFiles(files);
        return true;
      },
      handlePaste: (_view, event) => {
        const files = Array.from(event.clipboardData?.files ?? []).filter(isAttachmentFile);
        if (files.length === 0) return false;
        event.preventDefault();
        void handleUploadFiles(files);
        return true;
      },
    },
  });

  // 文書パスが変わった(移動・リネーム)ときに storage を追随させる
  useEffect(() => {
    if (!editor) return;
    editor.storage.tsumiwikiDoc = {
      folder: folderOfPath(doc.path),
      path: doc.path,
      openAttachmentMenu,
      openAttachmentLightbox,
    };
  }, [editor, doc.path, openAttachmentMenu, openAttachmentLightbox]);

  // #211: タブ切替等でdoc.pathが変わったら、前の文書で開いたままのライトボックス/
  // 添付メニューは意味を失うので明示的に閉じる(レビュー中#9)
  // #224: ソース編集モードも同様に、文書が切り替わったら前の文書のソース表示を持ち越さない
  useEffect(() => {
    setLightbox(null);
    setAttachmentMenu(null);
    setTableMenu(null);
    setSourceMode(false);
  }, [doc.path]);

  useEffect(() => {
    if (!editor) return;
    // 第2引数 emitUpdate=false: setEditable の既定は true で、モード切替のたびに
    // onUpdate → updateBody → dirty=true が誤発火する(初回マウントすら未保存扱いになる)
    editor.setEditable(session.mode === 'edit', false);
    // 編集モードに入ったら本文先頭にカーソルを出す(#51: 開いた瞬間から入力可能に)
    if (session.mode === 'edit') {
      editor.commands.focus('start');
    }
  }, [editor, session.mode]);

  // #222: 編集モードを抜けたら開いたままの表メニューを閉じる
  useEffect(() => {
    if (session.mode !== 'edit') setTableMenu(null);
  }, [session.mode]);

  // #224: 編集モードを抜けたらソース編集モードも解除する(破棄・ロック失効・競合解消など、
  // 編集セッションが閉じる経路はすべて session.mode の 'view' 遷移に集約されている)。
  // textarea内容をWYSIWYGへ反映してから解除する(直後に走る「閲覧モードではdoc.bodyへ追随」
  // のeffectがサーバー側の真値で上書きするため、破棄系の遷移では最終的にdoc.body側が勝つ)
  const sourceModeRef = useRef(sourceMode);
  sourceModeRef.current = sourceMode;
  const sourceTextRef = useRef(sourceText);
  sourceTextRef.current = sourceText;
  useEffect(() => {
    if (session.mode === 'edit') return;
    if (!sourceModeRef.current) return;
    if (editor && !editor.isDestroyed) {
      editor.commands.setContent(sourceTextRef.current, false);
    }
    setSourceMode(false);
  }, [session.mode, editor]);

  // 文書オープン/切替時はツールバーを非表示にリセットする。
  // その後ユーザーがエディタで実操作したら showEditorChrome で表示ONになる(下の useEffect)。
  useEffect(() => {
    resetEditorChrome();
  }, [doc.path, resetEditorChrome]);

  // editor.commands.focus('start') は自動発火なので focus イベントを条件にすると即出てしまう。
  // 代わりに click / keydown / touchstart / paste を捕捉して、ユーザー起因の操作を検知する
  useEffect(() => {
    if (!editor || session.mode !== 'edit') return;
    const dom = editor.view.dom;
    // IME 変換中の keydown で発火すると、iPadOS Safari で編集ツールバーの出現に伴う
    // レイアウトシフトが起き、外部キーボードの Space による変換候補選択移動が奪われる
    const handler = (e: Event) => {
      if (e instanceof KeyboardEvent && e.isComposing) return;
      showEditorChrome();
    };
    dom.addEventListener('click', handler);
    dom.addEventListener('keydown', handler);
    dom.addEventListener('touchstart', handler);
    dom.addEventListener('paste', handler);
    return () => {
      dom.removeEventListener('click', handler);
      dom.removeEventListener('keydown', handler);
      dom.removeEventListener('touchstart', handler);
      dom.removeEventListener('paste', handler);
    };
  }, [editor, session.mode, showEditorChrome]);

  // 閲覧中に限り、外部要因(他者更新・定期refetch等)でdocが変わったら本文を追随させる。
  // 編集中は絶対に上書きしない(編集内容が消えるため)。
  // 第2引数 emitUpdate=false: setContent の反映で onUpdate → updateBody → dirty=true と
  // なってしまうのを防ぐ(保存直後にdocが更新されて未保存扱いになる不具合の対処)
  useEffect(() => {
    if (session.mode === 'view' && editor && !editor.isDestroyed) {
      editor.commands.setContent(doc.body, false);
    }
  }, [editor, doc.body, session.mode]);

  // sessionは毎レンダリングで新しいオブジェクトになるため、refに固定して
  // keydownリスナーの登録/解除がレンダリングのたびに走らないようにする
  const sessionRef = useRef(session);
  sessionRef.current = session;

  useEffect(() => {
    // 非アクティブタブは Ctrl+S / Ctrl+K を拾わない。5タブ開いてるときに1回の Ctrl+S で
    // 5つの save() が飛ぶのを防ぐ
    if (!active) return;
    function handleKeyDown(e: KeyboardEvent) {
      const current = sessionRef.current;
      if (current.mode !== 'edit' || e.isComposing) return;
      const isMod = e.ctrlKey || e.metaKey;
      if (isMod && e.key.toLowerCase() === 's') {
        e.preventDefault();
        showEditorChrome();
        void current.save();
        return;
      }
      // Mod+Shift+K は wikilink サジェスト(#195)。ProseMirror の keymap は
      // preventDefault するが stopPropagation しないので window まで届く。
      // #224: ソース編集中はリンクダイアログが隠れたエディタへ書き込んでしまうため無効化
      if (isMod && !e.shiftKey && e.key.toLowerCase() === 'k') {
        if (sourceModeRef.current) return;
        e.preventDefault();
        showEditorChrome();
        setLinkDialogVisible(true);
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [active, showEditorChrome]);

  const lockedByOther = doc.lock && doc.lock.userId !== currentUser.id ? doc.lock : null;

  // StatusBar(AppShell)に他者ロック状況を伝える。非アクティブタブが書き込むと
  // アクティブタブの表示を壊すので、active のときだけ更新する
  useEffect(() => {
    if (!active) return;
    setLockedByOtherName(lockedByOther?.displayName ?? null);
    return () => setLockedByOtherName(null);
  }, [active, lockedByOther?.displayName, setLockedByOtherName]);

  // #51: 文書を開いた瞬間に編集モードに入る。他者ロック中は閲覧モードにフォールバック。
  // 1つの doc.path に対しては1度だけ試行する(startEditing 失敗時のトースト連発を避ける)
  const autoEditAttemptedRef = useRef<string | null>(null);
  const docBodyRef = useRef(doc.body);
  const docTagsRef = useRef(doc.tags);
  docBodyRef.current = doc.body;
  docTagsRef.current = doc.tags;
  useEffect(() => {
    if (!editor) return;
    // 非アクティブなタブは自動編集を試みない(バックグラウンドで不要なロックを取らない)。
    // アクティブに切り替わったタイミングでこの効果が再実行され、初めて startEditing が走る
    if (!active) return;
    if (lockedByOther) return;
    if (autoEditAttemptedRef.current === doc.path) return;
    autoEditAttemptedRef.current = doc.path;
    void sessionRef.current.startEditing(docBodyRef.current, docTagsRef.current);
  }, [editor, active, lockedByOther, doc.path]);

  // #51 Opus C1: 閲覧モードへ落ちたときは doc.tags(サーバ側の真値)へリセット。
  // 編集中は pendingTags を独立に持ち、Rename/Remove/Add の連続操作でも stale 化しない
  useEffect(() => {
    if (session.mode === 'view') setPendingTags(doc.tags);
  }, [session.mode, doc.tags]);

  function handleStartEdit() {
    // 手動で編集モードへ入り直すエントリ(閲覧モード落ち後のリトライ用)
    autoEditAttemptedRef.current = doc.path;
    setPendingTags(doc.tags);
    void session.startEditing(doc.body, doc.tags);
  }

  function handleSave() {
    void session.save();
  }

  function handleDiscardClick() {
    // #51 Opus H2: 編集破棄動線。dirty のときのみ確認ダイアログ、そうでなければ即キャンセル
    if (session.dirty) setDiscardConfirmVisible(true);
    else void session.cancelEditing();
  }

  function handleConfirmDiscard() {
    setDiscardConfirmVisible(false);
    void session.cancelEditing();
  }

  function handleTagNavigate(tag: string) {
    setSidebarTab('tag');
    toggleTag(tag);
  }

  function handleTagRename(oldName: string, newName: string) {
    // frontmatter(session.updateTags)+本文中インライン#tag の両方を書き換える。
    // editor.commands.setContent で emitUpdate=true にすることで onUpdate → session.updateBody が発火し、
    // dirty=true と contentRef の更新が自動的に行われる
    // 注意: setContent は undo history をリセットする既知の副作用がある(Tiptap)。タグ操作の頻度は低いため許容
    if (!editor || editor.isDestroyed) return;
    // 重複除去(名前衝突は TagChipEditor 側でも弾いているが二重防御)
    const nextTags = [...new Set(pendingTags.map((t) => (t === oldName ? newName : t)))];
    const currentBody = editor.storage.markdown.getMarkdown() as string;
    const nextBody = renameInlineTag(currentBody, oldName, newName);
    if (nextBody !== currentBody) {
      editor.commands.setContent(nextBody, true);
    }
    setPendingTags(nextTags);
    session.updateTags(nextTags);
  }

  function handleTagRemove(name: string) {
    if (!editor || editor.isDestroyed) return;
    const nextTags = pendingTags.filter((t) => t !== name);
    const currentBody = editor.storage.markdown.getMarkdown() as string;
    const nextBody = removeInlineTag(currentBody, name);
    if (nextBody !== currentBody) {
      editor.commands.setContent(nextBody, true);
    }
    setPendingTags(nextTags);
    session.updateTags(nextTags);
  }

  function handleTagAdd(name: string) {
    if (pendingTags.includes(name)) return;
    const nextTags = [...pendingTags, name];
    setPendingTags(nextTags);
    session.updateTags(nextTags);
  }

  // #224 ソース編集モードのトグル。WYSIWYG⇔textareaの間でMarkdown原文を直接受け渡しする
  function handleToggleSourceMode() {
    if (!editor || editor.isDestroyed) return;
    if (sourceMode) {
      // source→edit(WYSIWYG): textareaの内容をtiptap-markdown経由でパースして反映する。
      // emitUpdate=false(既定)でonUpdateの再正規化を経由させず、textareaの原文そのままを
      // session.updateBodyへ渡す(setContentが再シリアライズした結果と食い違わせないため)
      editor.commands.setContent(sourceText);
      session.updateBody(sourceText);
      setSourceMode(false);
    } else {
      // edit(WYSIWYG)→source: 現在の内容をMarkdownとして取り出しtextareaの初期値にする
      const markdown = editor.storage.markdown.getMarkdown() as string;
      setSourceText(markdown);
      setSourceMode(true);
    }
  }

  // sourceモード中のtextarea入力: 都度session.updateBodyを呼び、dirty管理・下書き自動保存・
  // 保存ボタン活性化を既存の経路のまま効かせる(IME変換中の特別処理は不要)
  function handleSourceTextChange(e: ReactChangeEvent<HTMLTextAreaElement>) {
    const value = e.target.value;
    setSourceText(value);
    session.updateBody(value);
  }

  function handleRestoreDraft() {
    const content = session.restoreDraft();
    editor?.commands.setContent(content);
  }

  function handleConfirmLink(url: string) {
    setLinkDialogVisible(false);
    if (!editor) return;
    if (!isAllowedLinkUrl(url)) {
      showToast('error', 'このURL形式は使用できません(http/https/mailto/fileのみ)');
      return;
    }
    if (editor.state.selection.empty) {
      editor
        .chain()
        .focus()
        .insertContent([
          { type: 'text', marks: [{ type: 'link', attrs: { href: url } }], text: url },
        ])
        .run();
    } else {
      editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run();
    }
  }

  // 複数ファイルは逐次アップロードし、成功をまとめて1トーストで通知する
  async function handleUploadFiles(files: File[]) {
    let inserted = 0;
    for (const file of files) {
      try {
        const result = await uploadAttachment(doc.path, file);
        editor
          ?.chain()
          .focus()
          .insertContent({ type: 'obsidianEmbed', attrs: { target: result.fileName } })
          .run();
        inserted++;
      } catch (err) {
        showToast(
          'error',
          err instanceof Error ? err.message : 'ファイルのアップロードに失敗しました',
        );
      }
    }
    if (inserted > 0) {
      showToast(
        'success',
        inserted === 1 ? 'ファイルを挿入しました' : `${inserted}件のファイルを挿入しました`,
      );
    }
  }

  // #199 画像の管理メニュー(名前変更/削除/パスをコピー)。embed-view/image-viewの
  // NodeViewから右クリック/「⋯」ボタンで呼ばれる(editor.storage.tsumiwikiDoc.openAttachmentMenu経由)
  async function handleOpenAttachmentMenu(req: AttachmentMenuRequest) {
    try {
      const resolved = await resolveAttachment(req.target, doc.path);
      setAttachmentMenu({ ...req, resolved });
    } catch (err) {
      if (err instanceof ApiRequestError && err.status === 404) {
        showToast('error', '画像ファイルが見つかりません');
        return;
      }
      showToast(
        'error',
        err instanceof ApiRequestError ? err.message : '画像情報の取得に失敗しました',
      );
    }
  }
  // NodeViewに渡すopenAttachmentMenuは生成時に固定される安定参照のため、
  // 実処理を持つ最新のhandleOpenAttachmentMenuを毎レンダリングでrefに反映する
  handleOpenAttachmentMenuRef.current = handleOpenAttachmentMenu;

  // #211 PDFの「拡大表示」: attachmentMenu.resolvedは既に解決済みのため/api/embedを経由せず
  // /api/files/...を直接組み立てる。埋め込みiframeと同じページを開けるよう、
  // menuに乗ってきたanchor(`#page=3`等)をsrc末尾のfragmentに引き継ぐ(レビュー重大#5)
  function handleOpenAttachmentLightboxFromMenu() {
    if (!attachmentMenu) return;
    const { resolved, anchor } = attachmentMenu;
    const base = toFilesUrl(resolved.path);
    const src = anchor ? `${base}#${encodeURI(anchor)}` : base;
    setLightbox({ kind: 'pdf', src, alt: resolved.name });
  }

  function handleCopyAttachmentPath() {
    if (!attachmentMenu) return;
    navigator.clipboard
      .writeText(attachmentMenu.resolved.path)
      .then(() => showToast('success', 'パスをコピーしました'))
      .catch(() => showToast('error', 'コピーに失敗しました'));
  }

  // 中#7: ダイアログを先に表示し(「参照を確認しています…」)、参照一覧が届いたら
  // referenceDocsを差し替える。確定ボタンはreferenceDocsがnullの間は無効(下のJSX側)
  function handleOpenDeleteAttachmentDialog() {
    if (!attachmentMenu) return;
    const { resolved } = attachmentMenu;
    setDeleteDialog({ resolved, referenceDocs: null });
    fetchAttachmentReferences(resolved.path)
      .then(({ docs }) => {
        setDeleteDialog((current) =>
          current && current.resolved.path === resolved.path
            ? { ...current, referenceDocs: docs }
            : current,
        );
      })
      .catch(() => {
        // 参照一覧の取得に失敗しても削除確認自体は表示する(件数の案内文だけ省略される)
        setDeleteDialog((current) =>
          current && current.resolved.path === resolved.path
            ? { ...current, referenceDocs: [] }
            : current,
        );
      });
  }

  async function handleConfirmDeleteAttachment() {
    if (!deleteDialog || deleteDialog.referenceDocs === null) return;
    const { resolved } = deleteDialog;
    setDeleteDialog(null);
    try {
      await deleteAttachment(resolved.path);
      showToast('success', 'ごみ箱へ移動しました');
      // エディタ内のノードはそのまま残す(Obsidianと同じ。次回表示時に404→チップ/壊れた画像アイコンになる)。
      // ただしブラウザは一度成功した<img src>を再取得しないため、表示中のNodeViewには
      // 「実体が変わった」ことを明示的に伝えて再取得させる(実機確認の指摘対応)
      dispatchAttachmentChanged([resolved.name]);
    } catch (err) {
      showToast('error', err instanceof ApiRequestError ? err.message : '削除に失敗しました');
    }
  }

  // サーバーから返る replacements(この文書で実際に書き換えたtarget→新target)に厳密一致する
  // ノード(obsidianEmbed / image / wikilink)・マーク(text上のlinkマークのhref)だけを
  // ProseMirrorトランザクションで置換する。一致が無ければ何もしない。
  // 戻り値は実際に置換したかどうか(呼び出し側のキャッシュ更新判定に使う)。
  // dispatch前にsuppressNextUpdateRefを立て、この1回だけonUpdateのdirty化を抑止する
  // (#199: サーバー側で既にファイルを書き換え済みのため、この置換自体は未保存編集として扱わない)
  //
  // Opusレビュー中A: 以前はobsidianEmbed/imageしか走査しておらず、サーバーが書き換える
  // `[[old.png]]`(wikilinkノード)・`[説明](old.png)`(linkマーク)がエディタに追随せず、
  // 次の保存でサーバーの書き換えが巻き戻ってしまうバグがあった(updatedAtは更新済みのため
  // 保存時の競合検知にも掛からず、リンク切れが静かに発生する)
  function applyAttachmentReplacementsToEditor(
    replacements: { from: string; to: string }[],
  ): boolean {
    if (!editor || editor.isDestroyed || replacements.length === 0) return false;
    const { state } = editor;
    const linkMarkType = state.schema.marks.link;
    let tr = state.tr;
    let changed = false;
    state.doc.descendants((node, pos) => {
      if (node.type.name === 'obsidianEmbed') {
        const target = node.attrs.target as string;
        const { file } = parseEmbedTarget(target);
        // 軽微1: image側(src.split(/[?#]/,1)[0])と判定基準を揃える
        // (parseEmbedTargetは既に#anchorを除去済みだが、?queryは対象外のため念のため揃える)
        const base = (file.split(/[?#]/, 1)[0] ?? '').trim();
        const hit = replacements.find((r) => r.from === base);
        if (hit) {
          const nextTarget = rewriteEmbedTargetFile(target, hit.to);
          if (nextTarget !== target) {
            tr = tr.setNodeMarkup(pos, undefined, { ...node.attrs, target: nextTarget });
            changed = true;
          }
        }
      } else if (node.type.name === 'image') {
        const src = node.attrs.src as string;
        const base = (src.split(/[?#]/, 1)[0] ?? '').trim();
        const hit = replacements.find((r) => r.from === base);
        if (hit) {
          const nextSrc = rewriteImageSrcFile(src, hit.to);
          if (nextSrc !== src) {
            tr = tr.setNodeMarkup(pos, undefined, { ...node.attrs, src: nextSrc });
            changed = true;
          }
        }
      } else if (node.type.name === 'wikilink') {
        const target = node.attrs.target as string;
        const base = (target.split(/[?#]/, 1)[0] ?? '').trim();
        const hit = replacements.find((r) => r.from === base);
        if (hit) {
          const nextTarget = rewriteWikilinkTargetFile(target, hit.to);
          if (nextTarget !== target) {
            tr = tr.setNodeMarkup(pos, undefined, { ...node.attrs, target: nextTarget });
            changed = true;
          }
        }
      } else if (node.isText && linkMarkType) {
        const mark = node.marks.find((m) => m.type === linkMarkType);
        if (mark) {
          const href = mark.attrs.href as string;
          const base = (href.split(/[?#]/, 1)[0] ?? '').trim();
          const hit = replacements.find((r) => r.from === base);
          if (hit) {
            const nextHref = rewriteLinkHrefFile(href, hit.to);
            if (nextHref !== href) {
              const from = pos;
              const to = pos + node.nodeSize;
              tr = tr.removeMark(from, to, linkMarkType);
              tr = tr.addMark(from, to, linkMarkType.create({ ...mark.attrs, href: nextHref }));
              changed = true;
            }
          }
        }
      }
    });
    if (!changed) return false;
    suppressNextUpdateRef.current = true;
    editor.view.dispatch(tr);
    return true;
  }

  async function handleConfirmRenameAttachment(newName: string) {
    if (!renameDialog) return;
    const { resolved } = renameDialog;
    setRenameDialog(null);
    let result;
    try {
      result = await renameAttachment({ path: resolved.path, newName });
    } catch (err) {
      if (err instanceof ApiRequestError && err.code === 'CONFLICT') {
        showToast('error', '同名のファイルがあります');
      } else {
        showToast(
          'error',
          err instanceof ApiRequestError ? err.message : '名前の変更に失敗しました',
        );
      }
      return;
    }

    // 現在文書がrewrittenDocsに含まれないときはエディタに一切触らない(Opusレビュー重大1)
    const own = result.rewrittenDocs.find((d) => d.path === doc.path);
    if (own) {
      const changed = applyAttachmentReplacementsToEditor(own.replacements);
      // React Queryキャッシュの更新(use-editing-session.tsの保存後の更新と同じやり方)。
      // updatedAtはeditorの有無・置換有無に関わらず更新する(次の保存で競合にならないように)。
      // bodyは実際に置換した場合だけ最新のMarkdownで更新する(軽微14)
      queryClient.setQueryData<DocResponse | undefined>(docQueryKey(doc.path), (old) => {
        if (!old) return old;
        if (changed && editor && !editor.isDestroyed) {
          return {
            ...old,
            updatedAt: own.updatedAt,
            body: editor.storage.markdown.getMarkdown() as string,
          };
        }
        return { ...old, updatedAt: own.updatedAt };
      });
    }
    // 他の開いているタブの文書は無効化して次回表示時に再取得させる
    for (const rewritten of result.rewrittenDocs) {
      if (rewritten.path !== doc.path) {
        queryClient.invalidateQueries({ queryKey: docQueryKey(rewritten.path) });
      }
    }
    // ブラウザは一度成功した<img src>を再取得しないため、旧名のまま表示中の
    // 他のNodeView(別タブ・ペイン等)にも実体が変わったことを伝える(実機確認の指摘対応)
    dispatchAttachmentChanged([resolved.name]);

    showToast('success', `名前を変更しました(${result.rewrittenDocs.length}件の文書の参照を更新)`);
  }

  // #84 Phase C: 選択されたテンプレを展開して現在のエディタに流し込む。
  // - applyMode='insert': カーソル位置に挿入
  // - applyMode='append': 文末に追記
  // どちらも `{{cursor}}` があれば挿入後のカーソル位置をマーカーの場所へ戻す。
  //
  // 挿入は 1 chain / 1 transaction にまとめて 1 回の undo で完全に取り消せるようにする
  // (中#5/#6/#12 対応)。境目位置は「挿入開始 + pre.size」で計算する。
  //
  // 既知の制限(重大#2): テンプレ本文の *行内* に `{{cursor}}` があると、
  // 前半・後半それぞれが独立ブロックとしてパースされるため段落境界が生じる。
  // 行頭・行末に置けば期待通りに動く。テンプレ設計上の注意点。
  async function applyTemplateToEditor(
    templatePath: string,
    applyMode: 'insert' | 'append',
  ): Promise<void> {
    if (!editor) return;
    let expanded: string;
    try {
      const res = await expandTemplate.mutateAsync({
        templatePath,
        title: titleFromPath(doc.path),
      });
      expanded = res.markdown;
    } catch {
      // useExpandTemplate 内で toast は出しているので握りつぶす
      return;
    }

    // 中#4: await 中にキャンセル(mode=view)された可能性があるので再確認して抜ける
    if (sessionRef.current.mode !== 'edit' || !editor.isEditable) return;

    // 重大#1: `String.split(sep, 2)` は 2 個目以降のマーカー右側を捨ててしまう。
    // indexOf + slice で「最初のマーカーで分割し、残り本文は post 側に保持する」
    const cursorIdx = expanded.indexOf(CURSOR_MARKER);
    const preRaw = cursorIdx === -1 ? expanded : expanded.slice(0, cursorIdx);
    const postRaw = cursorIdx === -1 ? '' : expanded.slice(cursorIdx + CURSOR_MARKER.length);

    const pre = parseMarkdownFragment(preRaw);
    const post = parseMarkdownFragment(postRaw);
    if (pre.content.length === 0 && post.content.length === 0) return;

    // 挿入位置。append は文末、insert は現在のカーソル位置
    const insertAt =
      applyMode === 'append' ? editor.state.doc.content.size : editor.state.selection.from;
    // pre と post の境目のカーソル位置(cursor マーカーがなければ挿入末尾)
    const cursorAt = insertAt + pre.size;

    // 1 chain / 1 transaction にまとめる(中#5 / #12: undo 1 回で完全 revert)
    const combined = [...pre.content, ...post.content];
    editor.chain().focus().insertContentAt(insertAt, combined).setTextSelection(cursorAt).run();

    showToast('success', 'テンプレートを適用しました');
  }

  // wikilinkクリックでの遷移(FR-OBS-02)とfile://・UNCリンクの「パスをコピー」(FR-LINK-02)
  function handleContainerClick(e: ReactMouseEvent<HTMLDivElement>) {
    const target = e.target as HTMLElement;

    // wikilink は atom ノードで内部にカーソルを置く意味がない。
    // #51 で文書オープン直後に自動編集モード化するため、モード分岐すると
    // 編集モード中はクリックが遷移せずカーソル移動として吸われてしまう。
    // → モードに関わらず常に遷移として扱う。編集中の dirty は
    //   use-editing-session のアンマウント時 flush で draft 保存されるため
    //   SPA 遷移で失われない(#96 共通ヘルパを利用)
    if (handleWikilinkClick(target, wikilinkDocsRef.current, navigate, showToast)) {
      // 遷移が navigate → DocView アンマウント → PM 破棄と進むので、ここで
      // PM の click ハンドラを止める必要はない(preventDefault は no-op)
      return;
    }

    // 以降(file://・UNC のパスコピー、http(s) の新規タブ)は閲覧モードのみ。
    // 編集モードでは本文中の生 <a> はカーソル移動として扱う従来挙動を維持
    if (sessionRef.current.mode !== 'view') return;

    const anchorEl = target.closest('a');
    if (anchorEl) {
      const href = anchorEl.getAttribute('href') ?? '';
      if (href.startsWith('file:') || href.startsWith('\\\\')) {
        e.preventDefault();
        navigator.clipboard
          .writeText(href)
          .then(() => showToast('success', 'パスをコピーしました'))
          .catch(() => showToast('error', 'コピーに失敗しました'));
        return;
      }
      if (/^https?:/i.test(href)) {
        // 外部リンクは新規タブで開く(openOnClick:false のため自前処理)
        e.preventDefault();
        window.open(href, '_blank', 'noopener,noreferrer');
      }
    }
  }

  const breadcrumb = breadcrumbFromPath(doc.path);
  const badge = saveBadge(session.dirty, session.lastDraftSavedAt);

  return (
    <div className="flex h-full flex-col bg-canvas">
      <div className="flex items-start justify-between px-4 pb-4 pt-5 sm:px-6 lg:px-8">
        <div className="min-w-0">
          {breadcrumb.length > 0 && (
            <nav className="truncate text-xs text-ink-faint">
              {breadcrumb.map((segment, i) => (
                <span key={i}>
                  {i > 0 && <span className="mx-1">›</span>}
                  {segment}
                </span>
              ))}
            </nav>
          )}
          <h1 className="mt-1 truncate text-h1 text-ink">{titleFromPath(doc.path)}</h1>
          <p className="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-ink-faint">
            <span>更新</span>
            <span>{formatUpdatedAt(doc.updatedAt).date}</span>
            <span className="font-mono">{formatUpdatedAt(doc.updatedAt).time}</span>
            <span className={`font-medium ${badge.className}`}>{badge.label}</span>
            {/* #51: 即編集モードが基本のため、閲覧モードのときは明示バッジを出す。
                 他者ロック中(lockedByOther)か、なんらかの理由でロック取得できていない場合に該当 */}
            {session.mode === 'view' && (
              <span className="rounded bg-panel-2 px-1.5 py-0.5 text-ink-faint">閲覧モード</span>
            )}
            {lockedByOther && (
              <span className="text-warning">{lockedByOther.displayName}さんが編集中</span>
            )}
          </p>
          {/* #77 Phase A / #51: フロントマター+本文中の #タグ を合算したチップ列。
              閲覧モードでは TagPane フィルタ連動、編集モードでは各チップから改名/削除できる */}
          <TagChipEditor
            tags={session.mode === 'edit' ? pendingTags : doc.tags}
            // #224: ソース編集中のタグ操作は隠れたエディタ由来の本文で上書きし
            // textareaの編集内容と食い違うため編集不可にする(レビュー中1)
            editable={session.mode === 'edit' && !sourceMode}
            onNavigate={handleTagNavigate}
            onRename={handleTagRename}
            onRemove={handleTagRemove}
            onAdd={handleTagAdd}
          />
        </div>
        <div className="flex flex-shrink-0 gap-2">
          <button
            type="button"
            onClick={() => setHistoryVisible(true)}
            className="h-[30px] rounded border border-line px-3 text-sm text-ink-soft hover:bg-hoverbg"
          >
            <span aria-hidden="true">⟲</span> 履歴
          </button>
          {session.mode === 'view' ? (
            // 閲覧モード: ロック取得のリトライエントリ(他者編集終了後や取得失敗後の再試行)
            <button
              type="button"
              onClick={handleStartEdit}
              disabled={!!lockedByOther}
              title={lockedByOther ? `${lockedByOther.displayName}さんが編集中です` : undefined}
              className="h-8 rounded bg-accent px-3 text-sm text-white hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
            >
              <span aria-hidden="true">✎</span> 編集
            </button>
          ) : (
            // 編集モード: dirty のときのみ「破棄」を表示、保存は変更ありの間だけ活性化(#51)
            <>
              {session.dirty && (
                <button
                  type="button"
                  onClick={handleDiscardClick}
                  className="h-[30px] rounded border border-line px-3 text-sm text-ink-soft hover:bg-hoverbg"
                  title="編集内容を破棄"
                >
                  破棄
                </button>
              )}
              <button
                type="button"
                onClick={handleSave}
                disabled={!session.dirty}
                title={!session.dirty ? '変更がありません' : undefined}
                className="h-8 rounded bg-success px-3 text-sm text-white hover:bg-success-hover disabled:cursor-not-allowed disabled:opacity-50"
              >
                <span aria-hidden="true">✓</span> 保存
              </button>
            </>
          )}
        </div>
      </div>

      {session.mode === 'edit' && editor && editorChromeVisible && (
        <EditorToolbar
          editor={editor}
          onOpenLinkDialog={() => setLinkDialogVisible(true)}
          onPickImage={(file) => void handleUploadFiles([file])}
          onOpenTemplateApply={() => setTemplateApplyOpen(true)}
          sourceMode={sourceMode}
          onToggleSourceMode={handleToggleSourceMode}
        />
      )}

      <div
        className="flex-1 overflow-auto"
        onClick={handleContainerClick}
        // #175: 仮想キーボード直上に貼り付いた floating ツールバー(高さ 40px)の分と
        // キーボード高さを scroll 領域の下端に空けておかないと、フォーカス行がツールバー裏に隠れる。
        // paddingBottom はコンテンツをその分持ち上げる用。scrollPaddingBottom は iOS Safari の
        // contenteditable auto-scroll が「その帯を避けてキャレットを見せる」ようにするためで、
        // これがないと caret が浮きツールバー裏へ回り込む(#175 FU3)。
        style={
          keyboardBottomOffset > 0
            ? ({
                paddingBottom: `${keyboardBottomOffset + 40}px`,
                scrollPaddingBottom: `${keyboardBottomOffset + 40}px`,
                // #240: キーボード表示中はscroll past end余白を止め、二重加算を防ぐ
                '--scroll-past-end': '0px',
              } as CSSProperties)
            : undefined
        }
      >
        {/* コンテンツ幅は個人設定(#212)で normal=760px / wide=1040px / full=制約なし を切替。
            いずれもモバイル幅ではラッパ側の max-width が viewport 幅で頭打ちになり、
            狭くなるにつれ padding→本文ブロック順に自動追従する挙動は維持される */}
        <div
          data-testid="doc-content-wrap"
          className={`mx-auto ${contentWidthMaxClass(contentWidth)} px-4 py-4 sm:px-6 lg:px-8`}
        >
          {/* #224 ソース編集モード: editorインスタンスはunmountせず保持したままCSSで隠す
              (エディタ状態・NodeView等を保ったまま行き来できるようにするため) */}
          <div hidden={sourceMode}>
            <EditorContent editor={editor} />
          </div>
          {sourceMode && (
            <textarea
              data-testid="source-editor"
              className="min-h-[60vh] w-full resize-y rounded border border-line bg-canvas p-3 font-mono text-base leading-relaxed text-ink-soft focus:outline-none focus-visible:outline-none"
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              value={sourceText}
              onChange={handleSourceTextChange}
            />
          )}
        </div>
      </div>

      {session.draftPrompt && (
        <ConfirmDialog
          title="未保存の下書き"
          message="未保存の下書きがあります。復元しますか?"
          confirmLabel="復元"
          cancelLabel="破棄"
          variant="primary"
          onConfirm={handleRestoreDraft}
          onCancel={() => void session.discardDraftPrompt()}
        />
      )}

      {discardConfirmVisible && (
        <ConfirmDialog
          title="編集内容の破棄"
          message="編集内容を破棄しますか?"
          confirmLabel="破棄"
          cancelLabel="編集を続ける"
          onConfirm={handleConfirmDiscard}
          onCancel={() => setDiscardConfirmVisible(false)}
        />
      )}

      {session.conflict && (
        <ConfirmDialog
          title="保存の競合"
          message="保存先が取得後に変更されています。"
          confirmLabel="自分の内容で上書き保存"
          cancelLabel="破棄して最新を読み込む"
          onConfirm={() => void session.resolveConflictOverwrite()}
          onCancel={() => void session.resolveConflictDiscard()}
        />
      )}

      {linkDialogVisible && (
        <PromptDialog
          title="リンク"
          label="URL"
          defaultValue={(editor?.getAttributes('link').href as string | undefined) ?? ''}
          confirmLabel="設定"
          onConfirm={handleConfirmLink}
          onCancel={() => setLinkDialogVisible(false)}
        />
      )}

      {historyVisible && (
        <HistoryPanel
          path={doc.path}
          onClose={() => setHistoryVisible(false)}
          // #106: 編集中に復元されると dirty な内容で上書き保存される事故を防ぐ。
          // 復元前に編集セッションを片付け、閲覧モードへ戻してから restoreRevision を走らせる
          isDirty={session.mode === 'edit' && session.dirty}
          beforeRestore={session.mode === 'edit' ? session.cancelEditing : undefined}
        />
      )}

      {templateApplyOpen && (
        <TemplatePickerDialog
          mode="apply"
          onCancel={() => setTemplateApplyOpen(false)}
          onSubmit={(result) => {
            if (result.mode !== 'apply') return;
            setTemplateApplyOpen(false);
            void applyTemplateToEditor(result.templatePath, result.applyMode);
          }}
        />
      )}

      {/* #199 画像の管理メニュー / #211 PDFの拡大表示 */}
      {attachmentMenu && (
        <ContextMenu
          x={attachmentMenu.x}
          y={attachmentMenu.y}
          items={[
            // #211: PDFのみ「拡大表示」を先頭に追加する(画像はクリックで直接開くため不要)
            ...(isPdfFile(attachmentMenu.target)
              ? [{ label: '拡大表示', onSelect: handleOpenAttachmentLightboxFromMenu }]
              : []),
            {
              label: '名前を変更',
              onSelect: () => setRenameDialog({ resolved: attachmentMenu.resolved }),
            },
            { label: 'パスをコピー', onSelect: handleCopyAttachmentPath },
            { label: '削除', onSelect: handleOpenDeleteAttachmentDialog, danger: true },
          ]}
          onClose={() => setAttachmentMenu(null)}
        />
      )}

      {/* #222 表のコンテキストメニュー */}
      {tableMenu && editor && (
        <ContextMenu
          x={tableMenu.x}
          y={tableMenu.y}
          items={getTableMenuItems(editor, { showToast })}
          onClose={() => setTableMenu(null)}
        />
      )}

      {/* #211 画像・PDFの拡大表示 */}
      {lightbox && (
        <AttachmentLightbox
          kind={lightbox.kind}
          src={lightbox.src}
          alt={lightbox.alt}
          onClose={() => setLightbox(null)}
        />
      )}

      {renameDialog && (
        <PromptDialog
          title="画像の名前を変更"
          label="新しいファイル名"
          defaultValue={renameDialog.resolved.name}
          confirmLabel="変更"
          onConfirm={(newName) => void handleConfirmRenameAttachment(newName)}
          onCancel={() => setRenameDialog(null)}
        />
      )}

      {deleteDialog && (
        <ConfirmDialog
          title="画像の削除"
          message={
            deleteDialog.referenceDocs === null
              ? '参照を確認しています…'
              : deleteDialog.referenceDocs.filter((d) => d !== doc.path).length > 0
                ? `${deleteDialog.resolved.name} をごみ箱へ移動します。他の${
                    deleteDialog.referenceDocs.filter((d) => d !== doc.path).length
                  }文書からも参照されています。参照は書き換えません(表示されなくなります)。`
                : `${deleteDialog.resolved.name} をごみ箱へ移動します。`
          }
          confirmLabel="削除"
          confirmDisabled={deleteDialog.referenceDocs === null}
          onConfirm={() => void handleConfirmDeleteAttachment()}
          onCancel={() => setDeleteDialog(null)}
        />
      )}
    </div>
  );
}
