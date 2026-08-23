import { useQueryClient } from '@tanstack/react-query';
import { EditorContent, useEditor } from '@tiptap/react';
import { CURSOR_MARKER, type DocResponse, type DocSummary, type User } from '@tsumiwiki/shared';
import { type MouseEvent as ReactMouseEvent, useEffect, useMemo, useRef, useState } from 'react';
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
import type { AttachmentMenuRequest } from '../editor/doc-storage';
import { createEditorExtensions } from '../editor/markdown';
import { parseMarkdownFragment } from '../editor/parse-fragment';
import '../editor/editor.css';
import { useEditingSession } from '../hooks/use-editing-session';
import { useVirtualKeyboard } from '../hooks/use-virtual-keyboard';
import { titleFromPath } from '../lib/doc-path';
import { handleWikilinkClick } from '../lib/handle-wikilink-click';
import { removeInlineTag, renameInlineTag } from '../lib/inline-tag-rewrite';
import { isAbsoluteUrl, parseEmbedTarget } from '../lib/resolve-embed-src';
import { saveBadge } from '../lib/save-badge';
import { registerTabActions } from '../lib/tab-actions-registry';
import { useEditStore } from '../stores/edit';
import { useToastStore } from '../stores/toast';
import { useUIStore } from '../stores/ui';
import { ConfirmDialog } from './ConfirmDialog';
import { ContextMenu } from './ContextMenu';
import { EditorToolbar } from './EditorToolbar';
import { HistoryPanel } from './HistoryPanel';
import { PromptDialog } from './PromptDialog';
import { TagChipEditor } from './TagChipEditor';
import { TemplatePickerDialog } from './TemplatePickerDialog';

// 文書閲覧・編集画面(SC-02のMainPane。設計04章4.2/4.4・05章5.3〜5.5・デザインhandoff components.md)
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

const IMAGE_MIME_PREFIX = 'image/';

// #199 添付リネーム: エディタ内ノードの basename 置換用ヘルパー(純関数)。
// サーバー側の書き換え(findAttachmentReferences)と違い、クライアント側は
// 「表示中のエディタに写っているノードの見た目を追従させる」だけが目的のため、
// resolveAttachmentは呼ばずbasename一致(大文字小文字無視)という単純な規則にとどめる
function basenameOf(pathOrTarget: string): string {
  const withoutQueryOrHash = pathOrTarget.split(/[?#]/, 1)[0] ?? '';
  const idx = withoutQueryOrHash.lastIndexOf('/');
  return idx === -1 ? withoutQueryOrHash : withoutQueryOrHash.slice(idx + 1);
}

// `![[dir/old.png|300]]` の `dir/old.png` 部分のbasenameだけを新名に差し替える。
// `#anchor`・`|サイズ or 別名` はそのまま保持する
function rewriteEmbedTargetBasename(target: string, newName: string): string {
  const pipeIdx = target.indexOf('|');
  const rawFile = pipeIdx === -1 ? target : target.slice(0, pipeIdx);
  const pipePart = pipeIdx === -1 ? '' : target.slice(pipeIdx); // '|'込み
  const hashIdx = rawFile.indexOf('#');
  const file = hashIdx === -1 ? rawFile : rawFile.slice(0, hashIdx);
  const anchorPart = hashIdx === -1 ? '' : rawFile.slice(hashIdx); // '#'込み
  const dirIdx = file.lastIndexOf('/');
  const dir = dirIdx === -1 ? '' : file.slice(0, dirIdx + 1);
  return `${dir}${newName}${anchorPart}${pipePart}`;
}

// `![alt](sub/old.png)` の `sub/old.png` 部分のbasenameだけを新名に差し替える。
// `?query`・`#anchor` はそのまま保持する
function rewriteImageSrcBasename(src: string, newName: string): string {
  const hashOrQueryIdx = src.search(/[?#]/);
  const base = hashOrQueryIdx === -1 ? src : src.slice(0, hashOrQueryIdx);
  const suffix = hashOrQueryIdx === -1 ? '' : src.slice(hashOrQueryIdx);
  const dirIdx = base.lastIndexOf('/');
  const dir = dirIdx === -1 ? '' : base.slice(0, dirIdx + 1);
  return `${dir}${newName}${suffix}`;
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
  const [renameDialog, setRenameDialog] = useState<{
    resolved: { path: string; name: string };
  } | null>(null);
  const [deleteDialog, setDeleteDialog] = useState<{
    resolved: { path: string; name: string };
    referenceDocs: string[];
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
      },
      handleDrop: (_view, event) => {
        const files = Array.from(event.dataTransfer?.files ?? []).filter((f) =>
          f.type.startsWith(IMAGE_MIME_PREFIX),
        );
        if (files.length === 0) return false;
        event.preventDefault();
        void handleUploadImages(files);
        return true;
      },
      handlePaste: (_view, event) => {
        const files = Array.from(event.clipboardData?.files ?? []).filter((f) =>
          f.type.startsWith(IMAGE_MIME_PREFIX),
        );
        if (files.length === 0) return false;
        event.preventDefault();
        void handleUploadImages(files);
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
    };
  }, [editor, doc.path, openAttachmentMenu]);

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
      // preventDefault するが stopPropagation しないので window まで届く
      if (isMod && !e.shiftKey && e.key.toLowerCase() === 'k') {
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
  async function handleUploadImages(files: File[]) {
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
        showToast('error', err instanceof Error ? err.message : '画像のアップロードに失敗しました');
      }
    }
    if (inserted > 0) {
      showToast(
        'success',
        inserted === 1 ? '画像を挿入しました' : `${inserted}件の画像を挿入しました`,
      );
    }
  }

  async function handleUploadImage(file: File) {
    await handleUploadImages([file]);
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
      showToast('error', err instanceof ApiRequestError ? err.message : '画像情報の取得に失敗しました');
    }
  }
  // NodeViewに渡すopenAttachmentMenuは生成時に固定される安定参照のため、
  // 実処理を持つ最新のhandleOpenAttachmentMenuを毎レンダリングでrefに反映する
  handleOpenAttachmentMenuRef.current = handleOpenAttachmentMenu;

  function handleCopyAttachmentPath() {
    if (!attachmentMenu) return;
    navigator.clipboard
      .writeText(attachmentMenu.resolved.path)
      .then(() => showToast('success', 'パスをコピーしました'))
      .catch(() => showToast('error', 'コピーに失敗しました'));
  }

  async function handleOpenDeleteAttachmentDialog() {
    if (!attachmentMenu) return;
    const { resolved } = attachmentMenu;
    try {
      const { docs } = await fetchAttachmentReferences(resolved.path);
      setDeleteDialog({ resolved, referenceDocs: docs });
    } catch {
      // 参照一覧の取得に失敗しても削除確認自体は表示する(件数の案内文だけ省略される)
      setDeleteDialog({ resolved, referenceDocs: [] });
    }
  }

  async function handleConfirmDeleteAttachment() {
    if (!deleteDialog) return;
    const { resolved } = deleteDialog;
    setDeleteDialog(null);
    try {
      await deleteAttachment(resolved.path);
      showToast('success', 'ごみ箱へ移動しました');
      // エディタ内のノードはそのまま残す(Obsidianと同じ。次回表示時に404→チップ/壊れた画像アイコンになる)
    } catch (err) {
      showToast('error', err instanceof ApiRequestError ? err.message : '削除に失敗しました');
    }
  }

  // エディタ内の該当ノード(obsidianEmbed / image)のbasenameを新名に置換する。
  // ProseMirrorトランザクションを直接dispatchし、この1回だけonUpdateのdirty化を抑止する
  // (#199: サーバー側で既にファイルを書き換え済みのため、この置換自体は未保存編集として扱わない)
  function applyAttachmentRenameToEditor(oldName: string, newName: string) {
    if (!editor || editor.isDestroyed) return;
    const { state } = editor;
    let tr = state.tr;
    let changed = false;
    state.doc.descendants((node, pos) => {
      if (node.type.name === 'obsidianEmbed') {
        const target = node.attrs.target as string;
        const { file } = parseEmbedTarget(target);
        if (basenameOf(file).toLowerCase() === oldName.toLowerCase()) {
          const nextTarget = rewriteEmbedTargetBasename(target, newName);
          if (nextTarget !== target) {
            tr = tr.setNodeMarkup(pos, undefined, { ...node.attrs, target: nextTarget });
            changed = true;
          }
        }
      } else if (node.type.name === 'image') {
        const src = node.attrs.src as string;
        if (!isAbsoluteUrl(src) && basenameOf(src).toLowerCase() === oldName.toLowerCase()) {
          const nextSrc = rewriteImageSrcBasename(src, newName);
          if (nextSrc !== src) {
            tr = tr.setNodeMarkup(pos, undefined, { ...node.attrs, src: nextSrc });
            changed = true;
          }
        }
      }
    });
    if (!changed) return;
    suppressNextUpdateRef.current = true;
    editor.view.dispatch(tr);
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
        showToast('error', err instanceof ApiRequestError ? err.message : '名前の変更に失敗しました');
      }
      return;
    }

    applyAttachmentRenameToEditor(resolved.name, result.name);

    // rewrittenDocsに現在文書が含まれていれば、React QueryキャッシュのupdatedAtとbodyを更新する
    // (use-editing-session.tsの保存後のキャッシュ更新と同じやり方。次の保存で競合にならないように)
    const own = result.rewrittenDocs.find((d) => d.path === doc.path);
    if (own && editor && !editor.isDestroyed) {
      const nextBody = editor.storage.markdown.getMarkdown() as string;
      queryClient.setQueryData<DocResponse | undefined>(docQueryKey(doc.path), (old) =>
        old ? { ...old, updatedAt: own.updatedAt, body: nextBody } : old,
      );
    }
    // 他の開いているタブの文書は無効化して次回表示時に再取得させる
    for (const rewritten of result.rewrittenDocs) {
      if (rewritten.path !== doc.path) {
        queryClient.invalidateQueries({ queryKey: docQueryKey(rewritten.path) });
      }
    }

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
            editable={session.mode === 'edit'}
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
          onPickImage={(file) => void handleUploadImage(file)}
          onOpenTemplateApply={() => setTemplateApplyOpen(true)}
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
            ? {
                paddingBottom: `${keyboardBottomOffset + 40}px`,
                scrollPaddingBottom: `${keyboardBottomOffset + 40}px`,
              }
            : undefined
        }
      >
        {/* コンテンツ幅は最大760pxで、狭くなるにつれ padding→本文ブロック順に自動追従する。
            記事幅がビューポート幅を超えないよう `max-w-full` を保険で入れる */}
        <div className="mx-auto max-w-[min(760px,100%)] px-4 py-4 sm:px-6 lg:px-8">
          <EditorContent editor={editor} />
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

      {/* #199 画像の管理メニュー */}
      {attachmentMenu && (
        <ContextMenu
          x={attachmentMenu.x}
          y={attachmentMenu.y}
          items={[
            {
              label: '名前を変更',
              onSelect: () => setRenameDialog({ resolved: attachmentMenu.resolved }),
            },
            { label: 'パスをコピー', onSelect: handleCopyAttachmentPath },
            { label: '削除', onSelect: () => void handleOpenDeleteAttachmentDialog(), danger: true },
          ]}
          onClose={() => setAttachmentMenu(null)}
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
            deleteDialog.referenceDocs.filter((d) => d !== doc.path).length > 0
              ? `${deleteDialog.resolved.name} をごみ箱へ移動します。他の${
                  deleteDialog.referenceDocs.filter((d) => d !== doc.path).length
                }文書からも参照されています。参照は書き換えません(表示されなくなります)。`
              : `${deleteDialog.resolved.name} をごみ箱へ移動します。`
          }
          confirmLabel="削除"
          onConfirm={() => void handleConfirmDeleteAttachment()}
          onCancel={() => setDeleteDialog(null)}
        />
      )}
    </div>
  );
}
