import {
  App,
  Component,
  Editor,
  FuzzySuggestModal,
  MarkdownFileInfo,
  MarkdownRenderer,
  MarkdownView,
  Menu,
  Modal,
  Notice,
  Platform,
  Plugin,
  TFile,
  TFolder,
  Setting,
  normalizePath,
  setIcon,
} from 'obsidian';
import { SubnoteNameModal } from './name-modal';
import {
  DEFAULT_SETTINGS,
  SubnoteStorageType,
  SubnotesSettings,
  SubnotesSettingTab,
} from './settings';
import { InterfaceLanguage, TranslationKey, translate } from './i18n';

type ObsidianNode = Node & {
  instanceOf<T>(type: { new (): T }): this is T;
};

function hasObsidianInstanceOf(value: EventTarget | Node | null): value is ObsidianNode {
  return (
    value !== null &&
    typeof (value as { instanceOf?: unknown }).instanceOf === 'function'
  );
}

function isHTMLElement(value: EventTarget | Node | null): value is HTMLElement {
  return hasObsidianInstanceOf(value) && value.instanceOf(HTMLElement);
}

function closestHTMLElement(element: Element, selector: string): HTMLElement | null {
  const match = element.closest(selector);
  return isHTMLElement(match) ? match : null;
}

class SubnotePickerModal extends FuzzySuggestModal<TFile> {
  constructor(
    app: App,
    private readonly language: InterfaceLanguage,
    private readonly files: TFile[],
    private readonly onChoose: (file: TFile) => void,
  ) {
    super(app);
    this.setPlaceholder(translate(this.language, 'chooseSubnotePlaceholder'));
  }

  getItems(): TFile[] {
    return this.files;
  }

  getItemText(file: TFile): string {
    return file.path;
  }

  onChooseItem(file: TFile): void {
    this.onChoose(file);
  }
}

class SubnoteTitleModal extends Modal {
  private value: string;

  constructor(
    app: App,
    private readonly language: InterfaceLanguage,
    initialValue: string,
    private readonly onSubmit: (title: string) => void,
  ) {
    super(app);
    this.value = initialValue;
  }

  onOpen(): void {
    const { contentEl } = this;
    const text = (key: TranslationKey): string => translate(this.language, key);

    new Setting(contentEl).setName(text('titleModalHeading')).setHeading();

    new Setting(contentEl)
      .setName(text('titleName'))
      .setDesc(text('titleDesc'))
      .addText((text) => {
        text.setValue(this.value).onChange((value) => {
          this.value = value;
        });

        text.inputEl.addEventListener('keydown', (event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            this.submit();
          }
        });

        window.setTimeout(() => {
          text.inputEl.focus();
          text.inputEl.select();
        }, 0);
      });

    new Setting(contentEl).addButton((button) =>
      button
        .setButtonText(text('saveButton'))
        .setCta()
        .onClick(() => this.submit()),
    );
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private submit(): void {
    const title = this.value.trim();
    this.close();
    this.onSubmit(title);
  }
}

class DeleteSubnoteModal extends Modal {
  private decided = false;

  constructor(
    app: App,
    private readonly language: InterfaceLanguage,
    private readonly file: TFile,
    private readonly onDecision: (deleteFile: boolean) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    const text = (key: TranslationKey, replacements?: Record<string, string>): string =>
      translate(this.language, key, replacements);

    new Setting(contentEl).setName(text('deleteModalHeading')).setHeading();
    contentEl.createEl('p', {
      text: text('deleteModalText', { name: this.file.basename }),
    });

    new Setting(contentEl)
      .addButton((button) =>
        button.setButtonText(text('keepFileButton')).onClick(() => this.finish(false)),
      )
      .addButton((button) =>
        button
          .setButtonText(text('moveToTrashButton'))
          .setWarning()
          .onClick(() => this.finish(true)),
      );
  }

  onClose(): void {
    this.contentEl.empty();
    if (!this.decided) this.onDecision(false);
  }

  private finish(deleteFile: boolean): void {
    if (this.decided) return;
    this.decided = true;
    this.close();
    this.onDecision(deleteFile);
  }
}

export default class SubnotesPlugin extends Plugin {
  settings: SubnotesSettings = DEFAULT_SETTINGS;
  private parentSubnoteRefs = new Map<string, Set<string>>();
  private referenceTrackingReady = false;
  private pendingDeletionPrompts = new Set<string>();
  private markdownContentCache = new Map<string, string>();
  private virtualTempEditors = new Map<
    string,
    { parentPath: string; id: string; opening: boolean }
  >();
  private readonly virtualTempFolder = '__obsidian-subnotes-tmp__';
  async onload(): Promise<void> {
    await this.loadSettings();
    this.applyCssSettings();
    this.addSettingTab(new SubnotesSettingTab(this.app, this));

    this.addCommand({
      id: 'new-subnote',
      name: this.t('commandNewSubnote'),
      editorCallback: (editor, view) => {
        this.promptAndCreateSubnote(editor, view);
      },
    });

    this.addCommand({
      id: 'include-subnote',
      name: this.t('commandIncludeSubnote'),
      editorCallback: (editor, view) => {
        this.promptAndIncludeSubnote(editor, view);
      },
    });

    this.registerEvent(
      this.app.workspace.on('editor-menu', (menu, editor, view) => {
        menu.addItem((item) => {
          item.setTitle(this.t('subnotesMenu')).setIcon('files');

          const submenuItem = item as unknown as { setSubmenu?: () => Menu };
          if (typeof submenuItem.setSubmenu !== 'function') {
            item
              .setTitle(this.t('commandNewSubnote'))
              .setIcon('file-plus-2')
              .onClick(() => this.promptAndCreateSubnote(editor, view));
            return;
          }

          const submenu = submenuItem.setSubmenu();

          submenu.addItem((subItem) =>
            subItem
              .setTitle(this.t('commandNewSubnote'))
              .setIcon('file-plus-2')
              .onClick(() => this.promptAndCreateSubnote(editor, view)),
          );

          submenu.addItem((subItem) =>
            subItem
              .setTitle(this.t('commandIncludeSubnote'))
              .setIcon('file-input')
              .onClick(() => this.promptAndIncludeSubnote(editor, view)),
          );
        });
      }),
    );

    this.registerMarkdownPostProcessor((element, context) => {
      this.decorateSubnoteEmbeds(element, context.sourcePath);
    });

    // The callout context menu is not the same as Obsidian's file-menu.
    // Intercept only our rendered sub-note callouts and show a dedicated menu.
    this.registerDomEvent(
      this.app.workspace.containerEl,
      'contextmenu',
      (event: MouseEvent) => this.showSubnoteContextMenu(event),
      { capture: true },
    );

    // Use one delegated capture handler for the pencil control. Obsidian can
    // recreate callout-title DOM nodes, especially for virtual callouts, so a
    // handler attached directly to the rendered icon is not reliable.
    this.registerDomEvent(
      this.app.workspace.containerEl,
      'click',
      (event: MouseEvent) => this.handleSubnoteEditClick(event),
      { capture: true },
    );

    // A simple click in the rendered body switches that sub-note to an
    // in-place Markdown editor. The pencil keeps opening the normal editor.
    this.registerDomEvent(
      this.app.workspace.containerEl,
      'click',
      (event: MouseEvent) => this.handleInlineSubnoteEditClick(event),
      { capture: true },
    );

    this.registerDomEvent(
      this.app.workspace.containerEl,
      'copy',
      (event: ClipboardEvent) => this.handleCopy(event),
      { capture: true },
    );

    this.registerEvent(
      this.app.vault.on('modify', (file) => {
        if (file instanceof TFile && file.extension === 'md') {
          if (this.virtualTempEditors.has(file.path)) {
            void this.syncVirtualTempEditor(file);
            return;
          }
          void this.handleMarkdownModified(file);
        }
      }),
    );

    this.registerEvent(
      this.app.vault.on('rename', (file, oldPath) => {
        if (file instanceof TFile) void this.handleFileRenamed(file, oldPath);
      }),
    );

    this.registerEvent(
      this.app.vault.on('delete', (file) => {
        if (file instanceof TFile) void this.handleFileDeleted(file.path);
      }),
    );

    this.installRenderedSubnoteObserver();

    this.registerEvent(
      this.app.workspace.on('file-open', (file) => {
        if (file && !this.virtualTempEditors.has(file.path)) {
          void this.normalizeSubnoteFoldState(file);
        }
        window.setTimeout(() => void this.cleanupClosedVirtualTempEditors(), 0);
      }),
    );

    this.registerEvent(
      this.app.workspace.on('active-leaf-change', () => {
        window.setTimeout(() => void this.cleanupClosedVirtualTempEditors(), 0);
      }),
    );

    this.app.workspace.onLayoutReady(() => {
      void this.initializeReferenceTracking();
      const activeFile = this.app.workspace.getActiveFile();
      if (activeFile) void this.normalizeSubnoteFoldState(activeFile);
    });
  }

  onunload(): void {
    document.body.style.removeProperty('--obsidian-subnotes-max-height');
    document.body.style.removeProperty('--obsidian-subnotes-overflow-fade-size');
    document.body.classList.remove('obsidian-subnotes-custom-css-enabled');
    void this.cleanupAllVirtualTempEditors();
  }

  async loadSettings(): Promise<void> {
    const loaded = (await this.loadData()) as Partial<SubnotesSettings> | null;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, loaded ?? {});
    this.settings.knownSubnotes ??= [];
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    this.applyCssSettings();
  }

  private applyCssSettings(): void {
    document.body.classList.toggle(
      'obsidian-subnotes-custom-css-enabled',
      this.settings.customCssEnabled,
    );
    document.body.style.setProperty(
      '--obsidian-subnotes-callout-color',
      `var(--callout-${this.settings.subnoteColor})`,
    );

    if (this.settings.customCssEnabled) {
      document.body.style.removeProperty('--obsidian-subnotes-max-height');
      document.body.style.removeProperty('--obsidian-subnotes-overflow-fade-size');
      return;
    }

    const maxHeight = Math.max(60, Math.round(this.settings.maxEmbedHeight));
    const fadeSize = Math.max(10, Math.min(100, Math.round(this.settings.overflowFadeSize)));
    document.body.style.setProperty(
      '--obsidian-subnotes-max-height',
      `${maxHeight}px`,
    );
    document.body.style.setProperty(
      '--obsidian-subnotes-overflow-fade-size',
      `${fadeSize}px`,
    );
  }

  private t(
    key: TranslationKey,
    replacements: Record<string, string> = {},
  ): string {
    return translate(this.settings.interfaceLanguage, key, replacements);
  }

  private promptAndCreateSubnote(editor: Editor, view: MarkdownFileInfo): void {
    if (!view.file) {
      new Notice(this.t('noParentNotice'));
      return;
    }

    const parentFile = view.file;
    const selectedContent = editor.getSelection();
    const selectionFrom = editor.getCursor('from');
    const selectionTo = editor.getCursor('to');

    new SubnoteNameModal(
      this.app,
      this.settings.interfaceLanguage,
      this.settings.defaultStorageType,
      (name, storageType) => {
        void this.createSubnote(
          editor,
          parentFile,
          name,
          storageType,
          selectedContent,
          selectionFrom,
          selectionTo,
        );
      },
    ).open();
  }

  private promptAndIncludeSubnote(editor: Editor, view: MarkdownFileInfo): void {
    if (!view.file) {
      new Notice(this.t('noParentNotice'));
      return;
    }

    const parentFile = view.file;
    const files = this.getAvailableSubnotes(parentFile);

    if (files.length === 0) {
      new Notice(this.t('noSubnoteFoundNotice'));
      return;
    }

    new SubnotePickerModal(this.app, this.settings.interfaceLanguage, files, (file) => {
      void this.includeExistingSubnote(editor, file);
    }).open();
  }

  private async createSubnote(
    editor: Editor,
    parentFile: TFile,
    requestedName: string,
    storageType: SubnoteStorageType,
    selectedContent: string,
    selectionFrom: { line: number; ch: number },
    selectionTo: { line: number; ch: number },
  ): Promise<void> {
    if (storageType === 'virtual') {
      this.createVirtualSubnote(
        editor,
        parentFile,
        requestedName,
        selectedContent,
        selectionFrom,
        selectionTo,
      );
      return;
    }

    await this.createFileSubnote(
      editor,
      parentFile,
      requestedName,
      selectedContent,
      selectionFrom,
      selectionTo,
    );
  }

  private async createFileSubnote(
    editor: Editor,
    parentFile: TFile,
    requestedName: string,
    selectedContent: string,
    selectionFrom: { line: number; ch: number },
    selectionTo: { line: number; ch: number },
  ): Promise<void> {
    const displayTitle = requestedName.trim();
    const baseName = this.cleanFilename(this.filenameFromDisplayTitle(displayTitle));
    if (!displayTitle || !baseName) {
      new Notice(this.t('invalidSubnoteNameNotice'));
      return;
    }

    const finalName = this.cleanFilename(this.buildFilename(baseName));
    const folder = this.getTargetFolder(parentFile);
    await this.ensureFolder(folder);

    const filePath = normalizePath(
      folder ? `${folder}/${finalName}.md` : `${finalName}.md`,
    );

    if (this.app.vault.getAbstractFileByPath(filePath)) {
      new Notice(this.t('fileExistsNotice', { path: filePath }));
      return;
    }

    const subnote = await this.app.vault.create(filePath, selectedContent);
    this.markdownContentCache.set(subnote.path, selectedContent);
    await this.addKnownSubnote(subnote);

    const linkPath = subnote.path.slice(0, -3);
    this.insertBlockAtRange(
      editor,
      this.buildEmbedBlock(linkPath, displayTitle),
      selectionFrom,
      selectionTo,
    );

    await this.openSubnote(subnote, parentFile.path);
  }

  private createVirtualSubnote(
    editor: Editor,
    parentFile: TFile,
    requestedName: string,
    selectedContent: string,
    selectionFrom: { line: number; ch: number },
    selectionTo: { line: number; ch: number },
  ): void {
    const title = requestedName.trim();
    if (!title) {
      new Notice(this.t('invalidSubnoteNameNotice'));
      return;
    }

    const id = this.createVirtualSubnoteId();
    this.insertBlockAtRange(
      editor,
      this.buildVirtualSubnoteBlock(id, title, selectedContent),
      selectionFrom,
      selectionTo,
    );

    // The editor transaction may not be visible through the workspace/vault yet,
    // especially when the selection replaces the whole document. Reuse the
    // snapshot captured before the modal opened instead of immediately reading
    // the freshly inserted callout back from the parent note.
    void this.openVirtualSubnoteEditor(parentFile, id, {
      title,
      content: selectedContent,
    });
  }

  private async includeExistingSubnote(editor: Editor, subnote: TFile): Promise<void> {
    await this.addKnownSubnote(subnote);
    this.includeSubnote(editor, subnote, subnote.basename);
  }

  private includeSubnote(editor: Editor, subnote: TFile, visibleTitle?: string): void {
    const linkPath = subnote.path.slice(0, -3);
    this.insertBlock(editor, this.buildEmbedBlock(linkPath, visibleTitle));
  }

  private buildEmbedBlock(linkPath: string, visibleTitle?: string): string {
    const foldMarker = this.getFoldMarker();
    const title = visibleTitle?.trim();
    return `> [!note]${foldMarker}${title ? ` ${title}` : ''}\n> ![[${linkPath}]]`;
  }

  private buildVirtualSubnoteBlock(id: string, title: string, content: string): string {
    const foldMarker = this.getFoldMarker();
    const normalizedContent = content.replace(/\r\n?/g, '\n');
    const quotedContent = normalizedContent
      ? normalizedContent
          .split('\n')
          .map((line) => `> ${line}`)
          .join('\n')
      : '> ';

    return `> [!subnote-virtual-${id}]${foldMarker} ${title}\n${quotedContent}`;
  }

  private createVirtualSubnoteId(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }

  private getFoldMarker(): '+' | '-' {
    return this.settings.defaultFoldState === 'collapsed' ? '-' : '+';
  }

  private getAvailableSubnotes(parentFile: TFile): TFile[] {
    return this.app.vault
      .getMarkdownFiles()
      .filter((file) => file.path !== parentFile.path)
      .filter((file) => this.isSubnotePickerCandidate(file, parentFile))
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  private isSubnotePickerCandidate(file: TFile, parentFile: TFile): boolean {
    if (this.isSubnoteFile(file, parentFile)) return true;

    // Legacy sub-notes may predate the filename indicator. Keep the configured
    // fixed folder searchable even when new sub-notes are currently created
    // beside their parent note. Once included, the file is added to knownSubnotes.
    const fixedFolder = normalizePath(this.settings.fixedFolder.trim());
    if (!fixedFolder) return false;

    return file.parent?.path === fixedFolder || file.path.startsWith(`${fixedFolder}/`);
  }

  private isSubnoteFile(file: TFile, parentFile?: TFile): boolean {
    if (this.settings.knownSubnotes.includes(file.path)) return true;
    if (this.isLegacySubnoteName(file.basename)) return true;

    const indicator = this.settings.indicator.trim();
    if (this.settings.indicatorEnabled && indicator) {
      return this.settings.indicatorPosition === 'prefix'
        ? file.basename.startsWith(indicator)
        : file.basename.endsWith(indicator);
    }

    if (this.settings.folderMode === 'fixed-folder') {
      const fixedFolder = normalizePath(this.settings.fixedFolder.trim());
      if (!fixedFolder) return false;
      return file.parent?.path === fixedFolder || file.path.startsWith(`${fixedFolder}/`);
    }

    if (parentFile) {
      return file.parent?.path === parentFile.parent?.path;
    }

    return false;
  }

  private isLegacySubnoteName(basename: string): boolean {
    return /^\[sub\]\s*/i.test(basename) || /\s*\[sub\]$/i.test(basename);
  }

  private async addKnownSubnote(file: TFile): Promise<void> {
    if (this.settings.knownSubnotes.includes(file.path)) return;
    this.settings.knownSubnotes.push(file.path);
    await this.saveSettings();
  }

  private async initializeReferenceTracking(): Promise<void> {
    const snapshots = new Map<string, Set<string>>();

    for (const file of this.app.vault.getMarkdownFiles()) {
      const content = await this.app.vault.cachedRead(file);
      this.markdownContentCache.set(file.path, content);
      snapshots.set(file.path, this.extractSubnoteRefs(file, content));
    }

    this.parentSubnoteRefs = snapshots;
    this.referenceTrackingReady = true;
  }

  private extractSubnoteRefs(parentFile: TFile, content: string): Set<string> {
    const refs = new Set<string>();
    const pattern = /^>\s*\[!note\](?:[+-])?[^\r\n]*\r?\n>\s*!\[\[([^\r\n]*?)\]\]/gm;
    let match: RegExpExecArray | null;

    while ((match = pattern.exec(content)) !== null) {
      const target = this.resolveLinkedFile(match[1], parentFile.path);
      if (target && this.isSubnoteFile(target, parentFile)) refs.add(target.path);
    }

    return refs;
  }

  private async handleMarkdownModified(file: TFile): Promise<void> {
    const content = await this.app.vault.read(file);
    this.markdownContentCache.set(file.path, content);
    if (!this.referenceTrackingReady) return;

    const previous = this.parentSubnoteRefs.get(file.path);
    const current = this.extractSubnoteRefs(file, content);
    this.parentSubnoteRefs.set(file.path, current);
    if (!previous) return;

    for (const removedPath of previous) {
      if (current.has(removedPath) || this.isSubnoteStillReferenced(removedPath)) continue;

      const target = this.app.vault.getAbstractFileByPath(removedPath);
      if (target instanceof TFile) this.promptDeleteRemovedSubnote(target);
    }
  }

  private isSubnoteStillReferenced(subnotePath: string): boolean {
    for (const refs of this.parentSubnoteRefs.values()) {
      if (refs.has(subnotePath)) return true;
    }
    return false;
  }

  private promptDeleteRemovedSubnote(file: TFile): void {
    if (this.pendingDeletionPrompts.has(file.path)) return;
    this.pendingDeletionPrompts.add(file.path);

    new DeleteSubnoteModal(this.app, this.settings.interfaceLanguage, file, (deleteFile) => {
      this.pendingDeletionPrompts.delete(file.path);
      if (!deleteFile) return;

      void (async () => {
        try {
          await this.app.fileManager.trashFile(file);
          await this.removeKnownSubnote(file.path);
          new Notice(this.t('subnoteMovedToTrashNotice', { name: file.basename }));
        } catch (error: unknown) {
          console.error('Obsidian Subnotes: failed to trash sub-note', error);
          new Notice(this.t('unableDeleteSubnoteNotice', { name: file.basename }));
        }
      })();
    }).open();
  }

  private async handleFileRenamed(file: TFile, oldPath: string): Promise<void> {
    const virtualTemp = this.virtualTempEditors.get(oldPath);
    if (virtualTemp) {
      this.virtualTempEditors.delete(oldPath);
      this.virtualTempEditors.set(file.path, virtualTemp);
      return;
    }

    const cachedContent = this.markdownContentCache.get(oldPath);
    if (cachedContent !== undefined) {
      this.markdownContentCache.delete(oldPath);
      this.markdownContentCache.set(file.path, cachedContent);
    }

    let settingsChanged = false;
    const knownIndex = this.settings.knownSubnotes.indexOf(oldPath);
    if (knownIndex >= 0) {
      this.settings.knownSubnotes[knownIndex] = file.path;
      settingsChanged = true;
    }

    const ownRefs = this.parentSubnoteRefs.get(oldPath);
    if (ownRefs) {
      this.parentSubnoteRefs.delete(oldPath);
      this.parentSubnoteRefs.set(file.path, ownRefs);
    }

    for (const refs of this.parentSubnoteRefs.values()) {
      if (refs.delete(oldPath)) refs.add(file.path);
    }

    if (settingsChanged) await this.saveSettings();
  }

  private async handleFileDeleted(path: string): Promise<void> {
    if (this.virtualTempEditors.delete(path)) return;

    this.markdownContentCache.delete(path);
    this.parentSubnoteRefs.delete(path);
    for (const refs of this.parentSubnoteRefs.values()) refs.delete(path);
    await this.removeKnownSubnote(path);
  }

  private async removeKnownSubnote(path: string): Promise<void> {
    const filtered = this.settings.knownSubnotes.filter((knownPath) => knownPath !== path);
    if (filtered.length === this.settings.knownSubnotes.length) return;
    this.settings.knownSubnotes = filtered;
    await this.saveSettings();
  }

  private decorateSubnoteEmbeds(element: HTMLElement, sourcePath: string): void {
    const embeds = element.querySelectorAll<HTMLElement>('.internal-embed[src]');

    embeds.forEach((embed) => {
      const linkPath = embed.getAttribute('src');
      if (!linkPath) return;

      const target = this.resolveLinkedFile(linkPath, sourcePath);
      if (!target || !this.isSubnoteFile(target)) return;

      this.decorateSubnoteEmbed(embed, sourcePath);
    });

    this.decorateVirtualSubnotes(element, sourcePath);
  }

  private installRenderedSubnoteObserver(): void {
    const root = this.app.workspace.containerEl;

    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of Array.from(mutation.addedNodes)) {
          if (isHTMLElement(node)) this.decorateRenderedTree(node);
        }
      }
    });

    observer.observe(root, { childList: true, subtree: true });
    this.register(() => observer.disconnect());

    this.app.workspace.onLayoutReady(() => this.decorateRenderedTree(root));
  }

  private decorateRenderedTree(root: HTMLElement): void {
    const embeds = new Set<HTMLElement>();

    if (root.matches('.internal-embed[src]')) embeds.add(root);
    const ancestorEmbed = root.closest<HTMLElement>('.internal-embed[src]');
    if (ancestorEmbed) embeds.add(ancestorEmbed);
    root
      .querySelectorAll<HTMLElement>('.internal-embed[src]')
      .forEach((embed) => embeds.add(embed));

    for (const embed of embeds) {
      const linkPath = embed.getAttribute('src');
      if (!linkPath || !this.looksLikeSubnoteLink(linkPath)) continue;
      this.decorateSubnoteEmbed(embed);
    }

    this.decorateVirtualSubnotes(root);
  }

  private decorateVirtualSubnotes(root: HTMLElement, sourcePath?: string): void {
    const callouts: HTMLElement[] = [];

    if (this.isVirtualSubnoteCallout(root)) callouts.push(root);
    callouts.push(
      ...Array.from(
        root.querySelectorAll<HTMLElement>('.callout[data-callout^="subnote-virtual-"]'),
      ),
    );

    for (const callout of callouts) {
      this.decorateVirtualSubnoteCallout(callout, sourcePath);
    }
  }

  private isVirtualSubnoteCallout(element: HTMLElement): boolean {
    return (element.dataset.callout ?? '').startsWith('subnote-virtual-');
  }

  private getVirtualSubnoteId(callout: HTMLElement): string | null {
    const type = callout.dataset.callout ?? '';
    if (!type.startsWith('subnote-virtual-')) return null;
    const id = type.slice('subnote-virtual-'.length);
    return id || null;
  }

  private decorateVirtualSubnoteCallout(
    callout: HTMLElement,
    sourcePath?: string,
  ): void {
    callout.classList.add(
      'obsidian-subnotes-callout',
      'obsidian-subnotes-virtual-callout',
    );
    if (sourcePath) callout.dataset.subnotesSourcePath = sourcePath;

    this.ensureVirtualFoldControl(callout);

    const content = callout.querySelector<HTMLElement>(':scope > .callout-content');
    if (content) this.ensureOverflowFade(content);

    const effectiveSourcePath =
      sourcePath ??
      callout.dataset.subnotesSourcePath ??
      this.app.workspace.getActiveFile()?.path ??
      '';
    if (effectiveSourcePath) {
      void this.renderVirtualSubnoteTitle(callout, effectiveSourcePath);
    }
  }

  private looksLikeSubnoteLink(linkPath: string): boolean {
    const clean = linkPath.split('|', 1)[0].split('#', 1)[0].replace(/\\/g, '/');
    const withoutExtension = clean.replace(/\.md$/i, '');

    if (this.settings.knownSubnotes.some((path) => path.replace(/\.md$/i, '') === withoutExtension)) {
      return true;
    }

    const basename = withoutExtension.split('/').pop() ?? withoutExtension;
    if (this.isLegacySubnoteName(basename)) return true;

    if (!this.settings.indicatorEnabled) return false;
    const indicator = this.settings.indicator.trim();
    if (!indicator) return false;

    return this.settings.indicatorPosition === 'prefix'
      ? basename.startsWith(indicator)
      : basename.endsWith(indicator);
  }

  private decorateSubnoteEmbed(embed: HTMLElement, sourcePath?: string): void {
    embed.classList.add('obsidian-subnotes-embed');
    if (sourcePath) embed.dataset.subnotesSourcePath = sourcePath;

    const callout = closestHTMLElement(embed, '.callout');
    callout?.classList.add('obsidian-subnotes-callout');
    if (callout && sourcePath) callout.dataset.subnotesSourcePath = sourcePath;

    // Keep folding usable even if Obsidian does not expose its native callout
    // chevron. The fallback uses the embed itself as the fold host.
    this.ensureFoldControl(embed, callout);

    const scrollContent = embed.querySelector<HTMLElement>('.markdown-embed-content');
    if (scrollContent) this.ensureOverflowFade(scrollContent);

    const effectiveSourcePath =
      sourcePath ??
      callout?.dataset.subnotesSourcePath ??
      embed.dataset.subnotesSourcePath ??
      this.app.workspace.getActiveFile()?.path ??
      '';
    if (callout && effectiveSourcePath) {
      void this.renderFileSubnoteTitle(callout, embed, effectiveSourcePath);
    }
  }

  private getFoldElements(
    embed: HTMLElement,
    callout: HTMLElement | null = closestHTMLElement(embed, '.callout'),
  ): { host: HTMLElement; content: HTMLElement; title: HTMLElement } | null {
    if (callout) {
      const content = callout.querySelector<HTMLElement>(':scope > .callout-content');
      const title = callout.querySelector<HTMLElement>(':scope > .callout-title');
      if (content && title) return { host: callout, content, title };
    }

    const content =
      embed.querySelector<HTMLElement>(':scope > .markdown-embed-content') ??
      embed.querySelector<HTMLElement>('.markdown-embed-content');
    if (!content) return null;

    const title =
      embed.querySelector<HTMLElement>(':scope > .markdown-embed-title') ?? embed;
    return { host: embed, content, title };
  }

  private ensureFoldControl(embed: HTMLElement, callout: HTMLElement | null): void {
    const fold = this.getFoldElements(embed, callout);
    if (!fold) return;

    const { host, content, title } = fold;
    host.classList.add('obsidian-subnotes-fold-host');
    if (callout) {
      callout.classList.add('is-collapsible');
      this.ensureEditControl(embed, callout);
    }
    this.hideNativeOpenLinkControl(embed);

    if (host.dataset.subnotesFoldInitialized !== 'true') {
      this.setFoldCollapsed(
        host,
        content,
        this.settings.defaultFoldState === 'collapsed',
      );
      host.dataset.subnotesFoldInitialized = 'true';
    }

    let toggle = title.querySelector<HTMLElement>(
      ':scope > .obsidian-subnotes-fold-toggle',
    );
    if (!toggle) {
      toggle = title.createEl('button', {
        cls: 'obsidian-subnotes-fold-toggle',
      });
      toggle.setAttribute('type', 'button');
      toggle.setAttribute('aria-label', this.t('collapseExpandLabel'));
      if (title === embed) toggle.classList.add('is-fallback');
      const titleInner = title.querySelector<HTMLElement>(':scope > .callout-title-inner');
      if (titleInner) {
        title.insertBefore(toggle, titleInner);
      } else if (title === embed) {
        title.insertBefore(toggle, title.firstChild);
      } else {
        title.prepend(toggle);
      }

      this.registerDomEvent(toggle, 'click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.setFoldCollapsed(host, content, !this.isFoldCollapsed(host, content));
        this.refreshFoldIcon(host);
      });
    }

    this.refreshFoldIcon(host);
  }

  private ensureVirtualFoldControl(callout: HTMLElement): void {
    const content = callout.querySelector<HTMLElement>(':scope > .callout-content');
    const title = callout.querySelector<HTMLElement>(':scope > .callout-title');
    if (!content || !title) return;

    callout.classList.add('obsidian-subnotes-fold-host', 'is-collapsible');
    this.ensureVirtualEditControl(callout);

    if (callout.dataset.subnotesFoldInitialized !== 'true') {
      this.setFoldCollapsed(
        callout,
        content,
        this.settings.defaultFoldState === 'collapsed',
      );
      callout.dataset.subnotesFoldInitialized = 'true';
    }

    let toggle = title.querySelector<HTMLElement>(
      ':scope > .obsidian-subnotes-fold-toggle',
    );
    if (!toggle) {
      toggle = title.createEl('button', {
        cls: 'obsidian-subnotes-fold-toggle',
      });
      toggle.setAttribute('type', 'button');
      toggle.setAttribute('aria-label', this.t('collapseExpandLabel'));

      const titleInner = title.querySelector<HTMLElement>(':scope > .callout-title-inner');
      if (titleInner) {
        title.insertBefore(toggle, titleInner);
      } else {
        title.prepend(toggle);
      }

      this.registerDomEvent(toggle, 'click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.setFoldCollapsed(
          callout,
          content,
          !this.isFoldCollapsed(callout, content),
        );
        this.refreshFoldIcon(callout);
      });
    }

    this.refreshFoldIcon(callout);
  }

  private ensureOverflowFade(content: HTMLElement): void {
    const update = (): void => {
      const overflowing = content.scrollHeight > content.clientHeight + 2;
      const atBottom =
        !overflowing ||
        content.scrollTop + content.clientHeight >= content.scrollHeight - 2;

      content.classList.toggle('obsidian-subnotes-overflowing', overflowing);
      content.classList.toggle('obsidian-subnotes-at-bottom', atBottom);
    };

    if (content.dataset.subnotesOverflowInitialized !== 'true') {
      content.dataset.subnotesOverflowInitialized = 'true';

      this.registerDomEvent(content, 'scroll', update, { passive: true });

      const resizeObserver = new ResizeObserver(update);
      resizeObserver.observe(content);
      this.register(() => resizeObserver.disconnect());

      const mutationObserver = new MutationObserver(update);
      mutationObserver.observe(content, {
        childList: true,
        subtree: true,
        characterData: true,
      });
      this.register(() => mutationObserver.disconnect());
    }

    window.requestAnimationFrame(update);
  }

  private ensureVirtualEditControl(callout: HTMLElement): void {
    const icon = callout.querySelector<HTMLElement>(
      ':scope > .callout-title > .callout-icon',
    );
    if (!icon) return;

    icon.dataset.subnotesEditInitialized = 'true';
    icon.classList.add('obsidian-subnotes-edit-icon');
    icon.setAttribute('role', 'button');
    icon.setAttribute('tabindex', '0');
    icon.setAttribute('aria-label', this.t('editLabel'));
    icon.setAttribute('title', this.t('editLabel'));
  }

  private ensureEditControl(embed: HTMLElement, callout: HTMLElement): void {
    const icon = callout.querySelector<HTMLElement>(':scope > .callout-title > .callout-icon');
    if (!icon) return;

    icon.dataset.subnotesEditInitialized = 'true';
    icon.classList.add('obsidian-subnotes-edit-icon');
    icon.setAttribute('role', 'button');
    icon.setAttribute('tabindex', '0');
    icon.setAttribute('aria-label', this.t('editLabel'));
    icon.setAttribute('title', this.t('editLabel'));
  }

  private handleSubnoteEditClick(event: MouseEvent): void {
    const target = event.target;
    if (!(target instanceof Element)) return;

    const icon = target.closest<HTMLElement>('.obsidian-subnotes-edit-icon, .callout-icon');
    if (!icon) return;

    const callout = icon.closest<HTMLElement>('.obsidian-subnotes-callout, .callout');
    if (!callout) return;
    if (!callout.classList.contains('obsidian-subnotes-callout') && !this.isVirtualSubnoteCallout(callout)) return;

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();

    const sourcePath =
      callout.dataset.subnotesSourcePath ??
      this.app.workspace.getActiveFile()?.path ??
      '';

    if (this.isVirtualSubnoteCallout(callout)) {
      const id = this.getVirtualSubnoteId(callout);
      if (!id) return;

      const parentFile = this.app.vault.getAbstractFileByPath(sourcePath);
      if (parentFile instanceof TFile) {
        void this.openVirtualSubnoteEditor(parentFile, id);
      }
      return;
    }

    const embed = callout.querySelector<HTMLElement>('.internal-embed[src]');
    const linkPath = embed?.getAttribute('src');
    if (!embed || !linkPath) return;

    const effectiveSourcePath =
      callout.dataset.subnotesSourcePath ??
      embed.dataset.subnotesSourcePath ??
      sourcePath;
    const file = this.resolveLinkedFile(linkPath, effectiveSourcePath);
    if (file) void this.openSubnote(file, effectiveSourcePath);
  }

  private handleInlineSubnoteEditClick(event: MouseEvent): void {
    if (event.button !== 0) return;

    const target = event.target;
    if (!isHTMLElement(target)) return;

    if (
      target.closest(
        '.obsidian-subnotes-inline-editor, .obsidian-subnotes-fold-toggle, .obsidian-subnotes-edit-icon, button, input, textarea, select, option, a, .internal-link, .external-link',
      )
    ) {
      return;
    }

    const callout = target.closest<HTMLElement>('.obsidian-subnotes-callout');
    if (!callout || this.isFoldCollapsedForCallout(callout)) return;

    if (this.isVirtualSubnoteCallout(callout)) {
      const content = callout.querySelector<HTMLElement>(':scope > .callout-content');
      if (!content || !content.contains(target)) return;

      const id = this.getVirtualSubnoteId(callout);
      if (!id) return;

      const sourcePath =
        callout.dataset.subnotesSourcePath ??
        this.app.workspace.getActiveFile()?.path ??
        '';
      const parentFile = this.app.vault.getAbstractFileByPath(sourcePath);
      if (!(parentFile instanceof TFile)) return;

      event.preventDefault();
      event.stopPropagation();
      void this.startVirtualInlineEditor(content, parentFile, id);
      return;
    }

    const embed = callout.querySelector<HTMLElement>('.internal-embed[src]');
    if (!embed) return;

    const content = target.closest<HTMLElement>('.markdown-embed-content');
    if (!content || !embed.contains(content)) return;

    const linkPath = embed.getAttribute('src');
    if (!linkPath) return;

    const sourcePath =
      callout.dataset.subnotesSourcePath ??
      embed.dataset.subnotesSourcePath ??
      this.app.workspace.getActiveFile()?.path ??
      '';
    const file = this.resolveLinkedFile(linkPath, sourcePath);
    if (!file) return;

    event.preventDefault();
    event.stopPropagation();
    void this.startFileInlineEditor(content, file);
  }

  private isFoldCollapsedForCallout(callout: HTMLElement): boolean {
    const content =
      callout.querySelector<HTMLElement>(':scope > .callout-content') ??
      callout.querySelector<HTMLElement>('.markdown-embed-content');
    return !!content && this.isFoldCollapsed(callout, content);
  }

  private async startFileInlineEditor(
    contentEl: HTMLElement,
    file: TFile,
  ): Promise<void> {
    const openView = this.getOpenMarkdownView(file.path);
    const markdown = openView
      ? openView.editor.getValue()
      : await this.app.vault.cachedRead(file);

    await this.startInlineEditor(contentEl, markdown, file.path, async (nextValue) => {
      const currentView = this.getOpenMarkdownView(file.path);
      if (currentView) {
        const editor = currentView.editor;
        const current = editor.getValue();
        if (current === nextValue) return;
        editor.replaceRange(
          nextValue,
          editor.offsetToPos(0),
          editor.offsetToPos(current.length),
        );
        return;
      }

      const current = await this.app.vault.cachedRead(file);
      if (current !== nextValue) await this.app.vault.modify(file, nextValue);
    });
  }

  private async startVirtualInlineEditor(
    contentEl: HTMLElement,
    parentFile: TFile,
    id: string,
  ): Promise<void> {
    const data = await this.getVirtualSubnoteData(parentFile, id);
    if (!data) {
      new Notice(this.t('virtualSubnoteNotFoundNotice'));
      return;
    }

    await this.startInlineEditor(contentEl, data.content, parentFile.path, async (nextValue) => {
      const current = await this.getVirtualSubnoteData(parentFile, id);
      if (!current || current.content === nextValue) return;
      await this.updateVirtualSubnote(parentFile, id, current.title, nextValue);
    });
  }

  private async startInlineEditor(
    contentEl: HTMLElement,
    initialValue: string,
    sourcePath: string,
    save: (value: string) => Promise<void>,
  ): Promise<void> {
    if (contentEl.dataset.subnotesInlineEditing === 'true') {
      contentEl.querySelector<HTMLElement>('.obsidian-subnotes-inline-editor')?.focus();
      return;
    }

    contentEl.dataset.subnotesInlineEditing = 'true';
    contentEl.classList.add('obsidian-subnotes-inline-editing');

    const editor = contentEl.createDiv({
      cls: 'obsidian-subnotes-inline-editor',
    });
    editor.contentEditable = 'true';
    editor.setAttribute('role', 'textbox');
    editor.setAttribute('aria-multiline', 'true');
    editor.setAttribute('aria-label', this.t('editSubnoteMarkdownLabel'));
    editor.spellcheck = true;
    const renderComponent = new Component();
    renderComponent.load();
    await MarkdownRenderer.render(this.app, initialValue, editor, sourcePath, renderComponent);

    const configuredHeight = this.settings.customCssEnabled
      ? contentEl.clientHeight
      : this.settings.maxEmbedHeight;
    const visibleHeight = Math.max(
      80,
      Math.min(configuredHeight || 240, contentEl.clientHeight || configuredHeight || 240),
    );
    editor.style.height = `${visibleHeight}px`;
    contentEl.appendChild(editor);

    let closing = false;
    let dirty = false;
    const close = async (commit: boolean): Promise<void> => {
      if (closing) return;
      closing = true;

      const nextValue = this.serializeInlineEditorMarkdown(editor);
      renderComponent.unload();
      editor.remove();
      delete contentEl.dataset.subnotesInlineEditing;
      contentEl.classList.remove('obsidian-subnotes-inline-editing');
      this.ensureOverflowFade(contentEl);

      if (!commit || !dirty || nextValue === initialValue) return;

      try {
        await save(nextValue);
      } catch (error: unknown) {
        console.error('Obsidian Subnotes: unable to save sub-note inline edit', error);
        new Notice(this.t('unableSaveInlineEditNotice'));
      }
    };

    editor.addEventListener('input', () => {
      dirty = true;
    });

    editor.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        void close(false);
        return;
      }

      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        editor.blur();
      }
    });

    editor.addEventListener('blur', () => {
      void close(true);
    }, { once: true });

    window.requestAnimationFrame(() => {
      editor.focus();
      this.moveCursorToEnd(editor);
    });
  }

  private moveCursorToEnd(element: HTMLElement): void {
    const selection = window.getSelection();
    if (!selection) return;

    const range = document.createRange();
    range.selectNodeContents(element);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  private serializeInlineEditorMarkdown(root: HTMLElement): string {
    const blocks = Array.from(root.childNodes)
      .map((node) => ({
        markdown: this.serializeMarkdownBlock(node),
        paragraph: isHTMLElement(node) && node.tagName.toLowerCase() === 'p',
      }))
      .filter((block) => block.markdown.trim().length > 0);

    return blocks
      .map((block, index) => {
        if (index === 0) return block.markdown;
        const previous = blocks[index - 1];
        const separator = previous.paragraph && block.paragraph ? '\n' : '\n\n';
        return `${separator}${block.markdown}`;
      })
      .join('')
      .replace(/\n{3,}/g, '\n\n')
      .trimEnd();
  }

  private serializeMarkdownBlock(node: Node): string {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? '';
    if (!isHTMLElement(node)) return '';

    if (node.matches('.heading-collapse-indicator, .collapse-indicator')) return '';

    const tag = node.tagName.toLowerCase();
    if (/^h[1-6]$/u.test(tag)) {
      return `${'#'.repeat(Number(tag[1]))} ${this.serializeMarkdownInlineChildren(node).trim()}`;
    }

    if (tag === 'ul' || tag === 'ol') {
      return Array.from(node.children)
        .filter((child): child is HTMLElement => isHTMLElement(child))
        .map((child, index) => {
          const prefix = tag === 'ol' ? `${index + 1}. ` : '- ';
          return `${prefix}${this.serializeMarkdownInlineChildren(child).trim()}`;
        })
        .join('\n');
    }

    if (tag === 'blockquote') {
      return this.serializeMarkdownInlineChildren(node)
        .split('\n')
        .map((line) => `> ${line}`)
        .join('\n');
    }

    if (tag === 'pre') {
      return `\`\`\`\n${node.textContent?.trimEnd() ?? ''}\n\`\`\``;
    }

    if (tag === 'br') return '\n';
    return this.serializeMarkdownInlineChildren(node).trimEnd();
  }

  private serializeMarkdownInlineChildren(element: HTMLElement): string {
    return Array.from(element.childNodes)
      .map((node) => this.serializeMarkdownInline(node))
      .join('');
  }

  private serializeMarkdownInline(node: Node): string {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? '';
    if (!isHTMLElement(node)) return '';

    const tag = node.tagName.toLowerCase();
    if (tag === 'br') return '\n';

    const content = this.serializeMarkdownInlineChildren(node);
    if (tag === 'strong' || tag === 'b') return `**${content}**`;
    if (tag === 'em' || tag === 'i') return `*${content}*`;
    if (tag === 's' || tag === 'del') return `~~${content}~~`;
    if (tag === 'code') return `\`${node.textContent ?? ''}\``;

    if (tag === 'a') {
      const target = node.dataset.href ?? node.getAttribute('href') ?? '';
      const label = content || node.textContent || target;
      if (!target || target === label) return label;
      return node.classList.contains('internal-link')
        ? `[[${target}${label !== target ? `|${label}` : ''}]]`
        : `[${label}](${target})`;
    }

    return content;
  }

  private hideNativeOpenLinkControl(embed: HTMLElement): void {
    const controls = embed.querySelectorAll<HTMLElement>(
      '.markdown-embed-link, [aria-label="Open link"], [aria-label="Ouvrir le lien"], [title="Open link"], [title="Ouvrir le lien"]',
    );
    controls.forEach((control) => control.classList.add('obsidian-subnotes-open-link-hidden'));
  }

  private isFoldCollapsed(host: HTMLElement, content: HTMLElement): boolean {
    return host.classList.contains('is-collapsed') || content.style.display === 'none';
  }

  private setFoldCollapsed(
    host: HTMLElement,
    content: HTMLElement,
    collapsed: boolean,
  ): void {
    host.classList.toggle('is-collapsed', collapsed);
    content.style.display = collapsed ? 'none' : '';
    this.refreshFoldIcon(host);
  }

  private refreshFoldIcon(host: HTMLElement): void {
    const toggle = host.querySelector<HTMLElement>('.obsidian-subnotes-fold-toggle');
    if (!toggle) return;

    const content =
      host.querySelector<HTMLElement>(':scope > .callout-content') ??
      host.querySelector<HTMLElement>('.markdown-embed-content');
    const collapsed = content ? this.isFoldCollapsed(host, content) : false;

    toggle.empty();
    setIcon(toggle, collapsed ? 'chevron-right' : 'chevron-down');
    toggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    toggle.setAttribute('title', collapsed ? this.t('expandLabel') : this.t('collapseLabel'));
  }

  private handleCopy(event: ClipboardEvent): void {
    if (!this.settings.resolveSubnotesOnCopy) return;

    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    const parentFile = view?.file;
    if (!view || !parentFile) return;

    const selectedMarkdown = view.editor.getSelection();
    if (!selectedMarkdown) return;

    const resolvedMarkdown = this.resolveSubnotesForCopy(
      selectedMarkdown,
      parentFile,
    );
    if (resolvedMarkdown === selectedMarkdown) return;

    const clipboard = event.clipboardData;
    if (!clipboard) return;

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    clipboard.setData('text/plain', resolvedMarkdown);
    clipboard.setData('text/markdown', resolvedMarkdown);
  }

  private resolveSubnotesForCopy(markdown: string, parentFile: TFile): string {
    const filePattern =
      /^>\s*\[!note\](?:[+-])?[^\r\n]*\r?\n>\s*!\[\[([^\r\n]*?)\]\]/gm;

    const withFileSubnotes = markdown.replace(
      filePattern,
      (fullMatch: string, rawLink: string) => {
        const target = this.resolveLinkedFile(rawLink, parentFile.path);
        if (!target || !this.isSubnoteFile(target, parentFile)) return fullMatch;

        const content = this.markdownContentCache.get(target.path);
        if (content === undefined) return fullMatch;

        return content.replace(/\s+$/u, '');
      },
    );

    const virtualPattern =
      /^> \[!subnote-virtual-[^\]]+\](?:[+-])?[^\r\n]*\r?\n((?:>[^\r\n]*(?:\r?\n|$))*)/gm;

    return withFileSubnotes.replace(
      virtualPattern,
      (fullMatch: string, quotedContent: string) => {
        const trailingEol = fullMatch.endsWith('\r\n')
          ? '\r\n'
          : fullMatch.endsWith('\n')
            ? '\n'
            : '';
        return `${this.unquoteVirtualSubnoteContent(quotedContent).replace(/\s+$/u, '')}${trailingEol}`;
      },
    );
  }

  private showSubnoteContextMenu(event: MouseEvent): void {
    const target = event.target;
    if (!(target instanceof Element)) return;

    const callout = target.closest<HTMLElement>('.obsidian-subnotes-callout, .callout');
    if (callout && this.isVirtualSubnoteCallout(callout)) {
      this.showVirtualSubnoteContextMenu(event, callout);
      return;
    }

    const embed =
      callout?.querySelector<HTMLElement>('.internal-embed[src]') ??
      target.closest<HTMLElement>('.internal-embed[src]');
    if (!embed) return;

    const linkPath = embed.getAttribute('src');
    if (!linkPath || !this.looksLikeSubnoteLink(linkPath)) return;

    const sourcePath =
      callout?.dataset.subnotesSourcePath ??
      embed.dataset.subnotesSourcePath ??
      this.app.workspace.getActiveFile()?.path ??
      '';
    const file = this.resolveLinkedFile(linkPath, sourcePath);
    if (!file || !this.isSubnoteFile(file)) return;

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();

    const fold = this.getFoldElements(embed, callout);
    const menu = new Menu();

    menu.addItem((item) =>
      item
        .setTitle(this.t('editLabel'))
        .setIcon('pencil')
        .onClick(() => void this.openSubnote(file, sourcePath)),
    );

    const parentFile = this.app.vault.getAbstractFileByPath(sourcePath);
    if (parentFile instanceof TFile) {
      menu.addItem((item) =>
        item
          .setTitle(this.t('changeTitleLabel'))
          .setIcon('text-cursor-input')
          .onClick(() => void this.promptVisibleTitle(parentFile, linkPath)),
      );
    }

    if (fold) {
      const collapsed = this.isFoldCollapsed(fold.host, fold.content);
      menu.addItem((item) =>
        item
          .setTitle(collapsed ? this.t('expandLabel') : this.t('collapseLabel'))
          .setIcon(collapsed ? 'chevron-down' : 'chevron-up')
          .onClick(() => {
            this.setFoldCollapsed(fold.host, fold.content, !collapsed);
            this.refreshFoldIcon(fold.host);
          }),
      );
    }

    menu.showAtMouseEvent(event);
  }

  private showVirtualSubnoteContextMenu(
    event: MouseEvent,
    callout: HTMLElement,
  ): void {
    const id = this.getVirtualSubnoteId(callout);
    if (!id) return;

    const sourcePath =
      callout.dataset.subnotesSourcePath ??
      this.app.workspace.getActiveFile()?.path ??
      '';
    const parentFile = this.app.vault.getAbstractFileByPath(sourcePath);
    if (!(parentFile instanceof TFile)) return;

    const content = callout.querySelector<HTMLElement>(':scope > .callout-content');
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();

    const menu = new Menu();
    menu.addItem((item) =>
      item
        .setTitle(this.t('editLabel'))
        .setIcon('pencil')
        .onClick(() => void this.openVirtualSubnoteEditor(parentFile, id)),
    );

    menu.addItem((item) =>
      item
        .setTitle(this.t('changeTitleLabel'))
        .setIcon('text-cursor-input')
        .onClick(() => void this.promptVirtualTitle(parentFile, id)),
    );

    if (content) {
      const collapsed = this.isFoldCollapsed(callout, content);
      menu.addItem((item) =>
        item
          .setTitle(collapsed ? this.t('expandLabel') : this.t('collapseLabel'))
          .setIcon(collapsed ? 'chevron-down' : 'chevron-up')
          .onClick(() => {
            this.setFoldCollapsed(callout, content, !collapsed);
            this.refreshFoldIcon(callout);
          }),
      );
    }

    menu.showAtMouseEvent(event);
  }

  private async promptVirtualTitle(parentFile: TFile, id: string): Promise<void> {
    const data = await this.getVirtualSubnoteData(parentFile, id);
    if (!data) {
      new Notice(this.t('virtualSubnoteNotFoundNotice'));
      return;
    }

    new SubnoteTitleModal(this.app, this.settings.interfaceLanguage, data.title, (title) => {
      void this.updateVirtualSubnote(parentFile, id, title, data.content);
    }).open();
  }

  private hasMarkdownTitleFormatting(title: string): boolean {
    const trimmed = title.trim();
    if (/^#{1,6}\s+\S/u.test(trimmed)) return true;
    if (/(?:\*\*[^*]+\*\*|__[^_]+__|~~[^~]+~~|`[^`]+`|\*[^*]+\*|_[^_]+_)/u.test(trimmed)) {
      return true;
    }
    if (/\[[^\]]+\]\([^\)]+\)/u.test(trimmed)) return true;
    return false;
  }

  private async renderMarkdownTitle(
    callout: HTMLElement,
    rawTitle: string,
    sourcePath: string,
  ): Promise<void> {
    const titleInner = callout.querySelector<HTMLElement>(
      ':scope > .callout-title > .callout-title-inner',
    );
    if (!titleInner) return;

    const raw = rawTitle.trim();
    const previousRaw = titleInner.dataset.subnotesMarkdownTitleRaw;

    if (!this.hasMarkdownTitleFormatting(raw)) {
      if (previousRaw !== undefined) {
        titleInner.empty();
        titleInner.textContent = raw;
        titleInner.classList.remove('obsidian-subnotes-title-markdown');
        delete titleInner.dataset.subnotesMarkdownTitleRaw;
      }
      return;
    }

    if (previousRaw === raw) return;

    const rendered = createDiv();
    const renderComponent = new Component();
    renderComponent.load();
    await MarkdownRenderer.render(this.app, raw, rendered, sourcePath, renderComponent);
    renderComponent.unload();

    // The title source remains untouched in Markdown. Only its rendered DOM is
    // replaced, so editing always gets the original Markdown code back.
    titleInner.empty();
    while (rendered.firstChild) titleInner.appendChild(rendered.firstChild);
    titleInner.classList.add('obsidian-subnotes-title-markdown');
    titleInner.dataset.subnotesMarkdownTitleRaw = raw;
  }

  private async renderVirtualSubnoteTitle(
    callout: HTMLElement,
    sourcePath: string,
  ): Promise<void> {
    const id = this.getVirtualSubnoteId(callout);
    if (!id) return;

    const parentFile = this.app.vault.getAbstractFileByPath(sourcePath);
    if (!(parentFile instanceof TFile)) return;

    const data = await this.getVirtualSubnoteData(parentFile, id);
    if (!data || !callout.isConnected) return;
    await this.renderMarkdownTitle(callout, data.title, sourcePath);
  }

  private async renderFileSubnoteTitle(
    callout: HTMLElement,
    embed: HTMLElement,
    sourcePath: string,
  ): Promise<void> {
    const rawLink = embed.getAttribute('src');
    if (!rawLink) return;

    const parentFile = this.app.vault.getAbstractFileByPath(sourcePath);
    if (!(parentFile instanceof TFile)) return;

    const rawTitle = await this.getVisibleTitle(parentFile, rawLink);
    if (!callout.isConnected) return;
    await this.renderMarkdownTitle(callout, rawTitle, sourcePath);
  }

  private async promptVisibleTitle(parentFile: TFile, rawLink: string): Promise<void> {
    const currentTitle = await this.getVisibleTitle(parentFile, rawLink);
    new SubnoteTitleModal(this.app, this.settings.interfaceLanguage, currentTitle, (title) => {
      void this.setVisibleTitle(parentFile, rawLink, title);
    }).open();
  }

  private async getVisibleTitle(parentFile: TFile, rawLink: string): Promise<string> {
    const content = await this.app.vault.cachedRead(parentFile);
    const pattern =
      /^> \[!note\]([+-]?)([^\r\n]*)\r?\n> !\[\[([^\r\n]*?)\]\]/gm;
    let match: RegExpExecArray | null;

    while ((match = pattern.exec(content)) !== null) {
      if (this.sameSubnoteLink(match[3], rawLink, parentFile.path)) {
        return match[2].trim();
      }
    }

    return '';
  }

  private async setVisibleTitle(
    parentFile: TFile,
    rawLink: string,
    title: string,
  ): Promise<void> {
    let replaced = false;

    await this.app.vault.process(parentFile, (content) => {
      const pattern =
        /^> \[!note\]([+-]?)([^\r\n]*)\r?\n> !\[\[([^\r\n]*?)\]\]/gm;

      return content.replace(
        pattern,
        (fullMatch: string, marker: string, _oldTitle: string, blockLink: string) => {
          if (replaced || !this.sameSubnoteLink(blockLink, rawLink, parentFile.path)) {
            return fullMatch;
          }

          replaced = true;
          const foldMarker = marker || this.getFoldMarker();
          const visibleTitle = title ? ` ${title}` : '';
          return `> [!note]${foldMarker}${visibleTitle}\n> ![[${blockLink}]]`;
        },
      );
    });
  }

  private sameSubnoteLink(a: string, b: string, sourcePath: string): boolean {
    const fileA = this.resolveLinkedFile(a, sourcePath);
    const fileB = this.resolveLinkedFile(b, sourcePath);
    return !!fileA && !!fileB && fileA.path === fileB.path;
  }

  private async openVirtualSubnoteEditor(
    parentFile: TFile,
    id: string,
    initialData?: { title: string; content: string },
  ): Promise<void> {
    const data = initialData ?? await this.getVirtualSubnoteData(parentFile, id);
    if (!data) {
      new Notice(this.t('virtualSubnoteNotFoundNotice'));
      return;
    }

    for (const [path, state] of this.virtualTempEditors.entries()) {
      if (state.parentPath !== parentFile.path || state.id !== id) continue;
      const existingEditor = this.app.vault.getAbstractFileByPath(path);
      if (existingEditor instanceof TFile) {
        await this.openSubnote(existingEditor, parentFile.path);
        return;
      }
      this.virtualTempEditors.delete(path);
    }

    await this.ensureFolder(this.virtualTempFolder);
    const tempPath = this.getVirtualTempPath(data.title, id);
    const existing = this.app.vault.getAbstractFileByPath(tempPath);
    const editorContent = this.compactVirtualEditorContent(data.content);
    let tempFile: TFile;

    if (existing instanceof TFile) {
      tempFile = existing;
      await this.app.vault.modify(tempFile, editorContent);
    } else if (existing) {
      new Notice(this.t('unableCreateTempEditorNotice', { path: tempPath }));
      return;
    } else {
      tempFile = await this.app.vault.create(tempPath, editorContent);
    }

    this.virtualTempEditors.set(tempFile.path, {
      parentPath: parentFile.path,
      id,
      opening: true,
    });

    try {
      await this.openSubnote(tempFile, parentFile.path);
    } finally {
      const state = this.virtualTempEditors.get(tempFile.path);
      if (state) state.opening = false;
    }
  }

  private getVirtualTempPath(title: string, id: string): string {
    const plainTitle =
      this.cleanFilename(this.filenameFromDisplayTitle(title)) ||
      this.t('virtualSubnoteFallbackName');
    const safeTitle = plainTitle.slice(0, 80);
    const suffix = id.replace(/[^a-z0-9-]/gi, '').slice(-12) || Date.now().toString(36);
    return normalizePath(`${this.virtualTempFolder}/${safeTitle} (${suffix}).md`);
  }

  private compactVirtualEditorContent(content: string): string {
    const normalized = content.replace(/\r\n?/g, '\n');
    const lines = normalized.split('\n');
    if (lines.length < 3) return normalized;

    const blankIndexes = lines
      .map((line, index) => (line.trim() ? -1 : index))
      .filter((index) => index >= 0);
    if (blankIndexes.length / lines.length < 0.25) return normalized;

    const mostlyAlternating = blankIndexes.every((index) => {
      const previous = lines[index - 1]?.trim();
      const next = lines[index + 1]?.trim();
      return !!previous && !!next;
    });

    return mostlyAlternating
      ? lines.filter((line) => line.trim()).join('\n')
      : normalized;
  }

  private async syncVirtualTempEditor(tempFile: TFile): Promise<void> {
    const state = this.virtualTempEditors.get(tempFile.path);
    if (!state) return;

    const parent = this.app.vault.getAbstractFileByPath(state.parentPath);
    if (!(parent instanceof TFile)) return;

    const data = await this.getVirtualSubnoteData(parent, state.id);
    if (!data) return;

    const content = await this.app.vault.read(tempFile);
    await this.updateVirtualSubnote(parent, state.id, data.title, content);
  }

  private isVirtualTempFileOpen(path: string): boolean {
    return this.app.workspace.getLeavesOfType('markdown').some((leaf) => {
      const view = leaf.view;
      return view instanceof MarkdownView && view.file?.path === path;
    });
  }

  private async cleanupClosedVirtualTempEditors(): Promise<void> {
    for (const [path, state] of Array.from(this.virtualTempEditors.entries())) {
      if (state.opening || this.isVirtualTempFileOpen(path)) continue;

      const file = this.app.vault.getAbstractFileByPath(path);
      if (file instanceof TFile) {
        await this.syncVirtualTempEditor(file);
        this.virtualTempEditors.delete(path);
        await this.app.vault.delete(file, true);
      } else {
        this.virtualTempEditors.delete(path);
      }
    }

    await this.removeVirtualTempFolderIfEmpty();
  }

  private async cleanupAllVirtualTempEditors(): Promise<void> {
    for (const [path] of Array.from(this.virtualTempEditors.entries())) {
      const file = this.app.vault.getAbstractFileByPath(path);
      if (file instanceof TFile) {
        await this.syncVirtualTempEditor(file);
        this.virtualTempEditors.delete(path);
        await this.app.vault.delete(file, true);
      } else {
        this.virtualTempEditors.delete(path);
      }
    }

    await this.removeVirtualTempFolderIfEmpty();
  }

  private async removeVirtualTempFolderIfEmpty(): Promise<void> {
    const folder = this.app.vault.getAbstractFileByPath(this.virtualTempFolder);
    if (!(folder instanceof TFolder) || folder.children.length > 0) return;
    await this.app.vault.delete(folder, true);
  }

  private async getVirtualSubnoteData(
    parentFile: TFile,
    id: string,
  ): Promise<{ title: string; content: string } | null> {
    const openView = this.getOpenMarkdownView(parentFile.path);
    const source =
      openView
        ? openView.editor.getValue()
        : await this.app.vault.cachedRead(parentFile);
    const pattern = this.getVirtualSubnotePattern(id);
    const match = pattern.exec(source);
    if (!match) return null;

    return {
      title: match[2].trim(),
      content: this.unquoteVirtualSubnoteContent(match[3]),
    };
  }

  private buildUpdatedVirtualSubnoteBlock(
    id: string,
    marker: string,
    title: string,
    content: string,
    trailingEol: string,
  ): string {
    const foldMarker = marker || this.getFoldMarker();
    const quotedContent = this.quoteVirtualSubnoteContent(content);
    const visibleTitle = title.trim() ? ` ${title.trim()}` : '';
    return `> [!subnote-virtual-${id}]${foldMarker}${visibleTitle}\n${quotedContent}${trailingEol}`;
  }

  private async updateVirtualSubnote(
    parentFile: TFile,
    id: string,
    title: string,
    content: string,
  ): Promise<void> {
    const openView = this.getOpenMarkdownView(parentFile.path);

    if (openView) {
      const editor = openView.editor;
      const source = editor.getValue();
      const pattern = this.getVirtualSubnotePattern(id);
      const match = pattern.exec(source);

      if (!match) {
        new Notice(this.t('virtualSubnoteNotFoundNotice'));
        return;
      }

      const fullMatch = match[0];
      const trailingEol = fullMatch.endsWith('\r\n')
        ? '\r\n'
        : fullMatch.endsWith('\n')
          ? '\n'
          : '';
      const replacement = this.buildUpdatedVirtualSubnoteBlock(
        id,
        match[1],
        title,
        content,
        trailingEol,
      );

      editor.replaceRange(
        replacement,
        editor.offsetToPos(match.index),
        editor.offsetToPos(match.index + fullMatch.length),
      );
      return;
    }

    let replaced = false;

    await this.app.vault.process(parentFile, (source) => {
      const pattern = this.getVirtualSubnotePattern(id);
      return source.replace(
        pattern,
        (fullMatch: string, marker: string) => {
          if (replaced) return fullMatch;
          replaced = true;
          const trailingEol = fullMatch.endsWith('\r\n')
            ? '\r\n'
            : fullMatch.endsWith('\n')
              ? '\n'
              : '';
          return this.buildUpdatedVirtualSubnoteBlock(
            id,
            marker,
            title,
            content,
            trailingEol,
          );
        },
      );
    });
  }

  private getOpenMarkdownView(path: string): MarkdownView | null {
    for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
      const view = leaf.view;
      if (view instanceof MarkdownView && view.file?.path === path) return view;
    }
    return null;
  }

  private getVirtualSubnotePattern(id: string): RegExp {
    const escapedId = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(
      String.raw`^> \[!subnote-virtual-${escapedId}\]([+-]?)([^\r\n]*)\r?\n((?:>[^\r\n]*(?:\r?\n|$))*)`,
      'm',
    );
  }

  private quoteVirtualSubnoteContent(content: string): string {
    const normalized = content.replace(/\r\n?/g, '\n');
    if (!normalized) return '> ';

    return normalized
      .split('\n')
      .map((line) => `> ${line}`)
      .join('\n');
  }

  private unquoteVirtualSubnoteContent(quoted: string): string {
    return quoted
      .replace(/\r\n?/g, '\n')
      .replace(/\n$/u, '')
      .split('\n')
      .map((line) => line.replace(/^> ?/, ''))
      .join('\n');
  }

  private async openSubnote(file: TFile, sourcePath = ''): Promise<void> {
    if (Platform.isMobile) {
      const navigationSource =
        sourcePath || this.app.workspace.getActiveFile()?.path || '';
      await this.app.workspace.openLinkText(
        file.path,
        navigationSource,
        false,
        { active: true },
      );
      return;
    }

    const leaf = this.app.workspace.getLeaf('tab');
    await leaf.openFile(file);
  }

  private resolveLinkedFile(linkPath: string, sourcePath: string): TFile | null {
    const cleanLinkPath = linkPath.split('|', 1)[0].split('#', 1)[0];
    return this.app.metadataCache.getFirstLinkpathDest(cleanLinkPath, sourcePath);
  }

  private async normalizeSubnoteFoldState(parentFile: TFile): Promise<void> {
    const foldMarker = this.getFoldMarker();

    await this.app.vault.process(parentFile, (content) => {
      const filePattern =
        /^> \[!note\](?:[+-])?([^\r\n]*)\r?\n> !\[\[([^\r\n]*?)\]\]/gm;

      const withFileSubnotes = content.replace(
        filePattern,
        (fullMatch: string, title: string, rawLink: string) => {
          const target = this.resolveLinkedFile(rawLink, parentFile.path);
          if (!target || !this.isSubnoteFile(target, parentFile)) return fullMatch;

          return `> [!note]${foldMarker}${title}\n> ![[${rawLink}]]`;
        },
      );

      const virtualPattern =
        /^> \[!subnote-virtual-([^\]]+)\](?:[+-])?([^\r\n]*)(?=\r?$)/gm;

      return withFileSubnotes.replace(
        virtualPattern,
        (_fullMatch: string, id: string, title: string) =>
          `> [!subnote-virtual-${id}]${foldMarker}${title}`,
      );
    });
  }

  private getTargetFolder(parentFile: TFile): string {
    if (this.settings.folderMode === 'same-folder') {
      return parentFile.parent?.path ?? '';
    }

    const fixedFolder = this.settings.fixedFolder.trim();
    return fixedFolder ? normalizePath(fixedFolder) : '';
  }

  private buildFilename(baseName: string): string {
    if (!this.settings.indicatorEnabled || !this.settings.indicator.trim()) {
      return baseName;
    }

    const indicator = this.settings.indicator.trim();
    return this.settings.indicatorPosition === 'prefix'
      ? `${indicator}${baseName}`
      : `${baseName}${indicator}`;
  }

  private filenameFromDisplayTitle(title: string): string {
    let plain = title.trim();

    // Keep Markdown in the visible title, but never put its formatting syntax
    // in the physical filename. This also avoids '#' being interpreted as a
    // heading anchor inside Obsidian wikilinks.
    plain = plain.replace(/^#{1,6}\s+/u, '');
    plain = plain.replace(/\[([^\]]+)\]\([^\)]+\)/gu, '$1');
    plain = plain.replace(/\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|([^\]]+))?\]\]/gu, (_match, target: string, alias?: string) => alias || target);
    plain = plain.replace(/\*\*([^*]+)\*\*/gu, '$1');
    plain = plain.replace(/__([^_]+)__/gu, '$1');
    plain = plain.replace(/~~([^~]+)~~/gu, '$1');
    plain = plain.replace(/`([^`]+)`/gu, '$1');
    plain = plain.replace(/\*([^*]+)\*/gu, '$1');
    plain = plain.replace(/_([^_]+)_/gu, '$1');
    plain = plain.replace(/#/gu, '');

    return plain.trim();
  }

  private cleanFilename(name: string): string {
    return name
      .replace(/\.md$/i, '')
      .replace(/[\\/:*?"<>|]/g, '-')
      .trim()
      .replace(/[. ]+$/g, '');
  }

  private async ensureFolder(folderPath: string): Promise<void> {
    if (!folderPath || folderPath === '/') return;

    const normalized = normalizePath(folderPath);
    const parts = normalized.split('/').filter(Boolean);
    let current = '';

    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      const existing = this.app.vault.getAbstractFileByPath(current);

      if (existing instanceof TFolder) continue;
      if (existing) {
        throw new Error(`Cannot create folder because a file exists at: ${current}`);
      }

      await this.app.vault.createFolder(current);
    }
  }

  private insertBlockAtRange(
    editor: Editor,
    block: string,
    from: { line: number; ch: number },
    to: { line: number; ch: number },
  ): void {
    const document = editor.getValue();
    const startOffset = editor.posToOffset(from);
    const endOffset = editor.posToOffset(to);
    const contentBefore = document.slice(0, startOffset);
    const contentAfter = document.slice(endOffset);
    const before = contentBefore && !contentBefore.endsWith('\n') ? '\n' : '';
    const after = contentAfter
      ? contentAfter.startsWith('\n') ? '\n' : '\n\n'
      : '\n';
    editor.replaceRange(`${before}${block}${after}`, from, to);
  }

  private insertBlock(editor: Editor, block: string): void {
    const cursor = editor.getCursor();
    const line = editor.getLine(cursor.line);
    const before = cursor.ch === 0 && line.length === 0 ? '' : '\n';
    const after = '\n\n';

    editor.replaceSelection(`${before}${block}${after}`);
  }
}
