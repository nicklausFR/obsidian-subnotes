import {
  App,
  Editor,
  FuzzySuggestModal,
  MarkdownFileInfo,
  MarkdownView,
  Menu,
  Modal,
  Notice,
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
  SubnotesSettings,
  SubnotesSettingTab,
} from './settings';

class SubnotePickerModal extends FuzzySuggestModal<TFile> {
  constructor(
    app: App,
    private readonly files: TFile[],
    private readonly onChoose: (file: TFile) => void,
  ) {
    super(app);
    this.setPlaceholder('Choisir une sub-note…');
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
    initialValue: string,
    private readonly onSubmit: (title: string) => void,
  ) {
    super(app);
    this.value = initialValue;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl('h3', { text: 'Titre affiché de la sub-note' });

    new Setting(contentEl)
      .setName('Titre')
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
        .setButtonText('Enregistrer')
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
    private readonly file: TFile,
    private readonly onDecision: (deleteFile: boolean) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl('h3', { text: 'Sub-note retirée' });
    contentEl.createEl('p', {
      text: `L’embed vers « ${this.file.basename} » a été supprimé. Supprimer aussi le fichier ?`,
    });

    new Setting(contentEl)
      .addButton((button) =>
        button.setButtonText('Conserver').onClick(() => this.finish(false)),
      )
      .addButton((button) =>
        button
          .setButtonText('Corbeille')
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
  async onload(): Promise<void> {
    await this.loadSettings();
    this.applyCssSettings();
    this.addSettingTab(new SubnotesSettingTab(this.app, this));

    this.addCommand({
      id: 'new-subnote',
      name: 'New sub-note',
      editorCallback: (editor, view) => {
        this.promptAndCreateSubnote(editor, view);
      },
    });

    this.addCommand({
      id: 'include-subnote',
      name: 'Include a sub-note',
      editorCallback: (editor, view) => {
        this.promptAndIncludeSubnote(editor, view);
      },
    });

    this.registerEvent(
      this.app.workspace.on('editor-menu', (menu, editor, view) => {
        menu.addItem((item) => {
          item.setTitle('Sub-notes').setIcon('files');

          const submenuItem = item as unknown as { setSubmenu?: () => Menu };
          if (typeof submenuItem.setSubmenu !== 'function') {
            item
              .setTitle('Nouvelle sub')
              .setIcon('file-plus-2')
              .onClick(() => this.promptAndCreateSubnote(editor, view));
            return;
          }

          const submenu = submenuItem.setSubmenu();

          submenu.addItem((subItem) =>
            subItem
              .setTitle('Nouvelle sub')
              .setIcon('file-plus-2')
              .onClick(() => this.promptAndCreateSubnote(editor, view)),
          );

          submenu.addItem((subItem) =>
            subItem
              .setTitle('Inclure une sub-note')
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

    this.registerDomEvent(
      this.app.workspace.containerEl,
      'copy',
      (event: ClipboardEvent) => this.handleCopy(event),
      { capture: true },
    );

    this.registerEvent(
      this.app.vault.on('modify', (file) => {
        if (file instanceof TFile && file.extension === 'md') {
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
        if (file) void this.normalizeSubnoteFoldState(file);
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
    const maxHeight = Math.max(60, Math.round(this.settings.maxEmbedHeight));
    document.body.style.setProperty(
      '--obsidian-subnotes-max-height',
      `${maxHeight}px`,
    );
  }

  private promptAndCreateSubnote(editor: Editor, view: MarkdownFileInfo): void {
    if (!view.file) {
      new Notice('No parent note is open.');
      return;
    }

    const parentFile = view.file;
    new SubnoteNameModal(this.app, (name) => {
      void this.createSubnote(editor, parentFile, name);
    }).open();
  }

  private promptAndIncludeSubnote(editor: Editor, view: MarkdownFileInfo): void {
    if (!view.file) {
      new Notice('No parent note is open.');
      return;
    }

    const parentFile = view.file;
    const files = this.getAvailableSubnotes(parentFile);

    if (files.length === 0) {
      new Notice('Aucune sub-note trouvée.');
      return;
    }

    new SubnotePickerModal(this.app, files, (file) => {
      void this.includeExistingSubnote(editor, file);
    }).open();
  }

  private async createSubnote(
    editor: Editor,
    parentFile: TFile,
    requestedName: string,
  ): Promise<void> {
    const baseName = this.cleanFilename(requestedName);
    if (!baseName) {
      new Notice('Invalid sub-note name.');
      return;
    }

    const finalName = this.cleanFilename(this.buildFilename(baseName));
    const folder = this.getTargetFolder(parentFile);
    await this.ensureFolder(folder);

    const filePath = normalizePath(
      folder ? `${folder}/${finalName}.md` : `${finalName}.md`,
    );

    if (this.app.vault.getAbstractFileByPath(filePath)) {
      new Notice(`A file already exists: ${filePath}`);
      return;
    }

    const subnote = await this.app.vault.create(filePath, '');
    this.markdownContentCache.set(subnote.path, '');
    await this.addKnownSubnote(subnote);
    this.includeSubnote(editor, subnote);

    const leaf = this.app.workspace.getLeaf('tab');
    await leaf.openFile(subnote);
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

    new DeleteSubnoteModal(this.app, file, (deleteFile) => {
      this.pendingDeletionPrompts.delete(file.path);
      if (!deleteFile) return;

      void (async () => {
        try {
          await this.app.fileManager.trashFile(file);
          await this.removeKnownSubnote(file.path);
          new Notice(`Sub-note envoyée à la corbeille : ${file.basename}`);
        } catch (error) {
          console.error('Obsidian Subnotes: failed to trash sub-note', error);
          new Notice(`Impossible de supprimer la sub-note : ${file.basename}`);
        }
      })();
    }).open();
  }

  private async handleFileRenamed(file: TFile, oldPath: string): Promise<void> {
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
  }

  private installRenderedSubnoteObserver(): void {
    const root = this.app.workspace.containerEl;

    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of Array.from(mutation.addedNodes)) {
          if (node instanceof HTMLElement) this.decorateRenderedTree(node);
        }
      }
    });

    observer.observe(root, { childList: true, subtree: true });
    this.register(() => observer.disconnect());

    this.app.workspace.onLayoutReady(() => this.decorateRenderedTree(root));
  }

  private decorateRenderedTree(root: HTMLElement): void {
    const embeds: HTMLElement[] = [];

    if (root.matches('.internal-embed[src]')) embeds.push(root);
    embeds.push(...Array.from(root.querySelectorAll<HTMLElement>('.internal-embed[src]')));

    for (const embed of embeds) {
      const linkPath = embed.getAttribute('src');
      if (!linkPath || !this.looksLikeSubnoteLink(linkPath)) continue;
      this.decorateSubnoteEmbed(embed);
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

    const callout = embed.closest('.callout') as HTMLElement | null;
    callout?.classList.add('obsidian-subnotes-callout');
    if (callout && sourcePath) callout.dataset.subnotesSourcePath = sourcePath;

    // Keep folding usable even if Obsidian does not expose its native callout
    // chevron. The fallback uses the embed itself as the fold host.
    this.ensureFoldControl(embed, callout);
  }

  private getFoldElements(
    embed: HTMLElement,
    callout: HTMLElement | null = embed.closest('.callout') as HTMLElement | null,
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
      toggle = document.createElement('button');
      toggle.className = 'obsidian-subnotes-fold-toggle';
      toggle.setAttribute('type', 'button');
      toggle.setAttribute('aria-label', 'Plier ou déplier la sub-note');
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

  private ensureEditControl(embed: HTMLElement, callout: HTMLElement): void {
    const icon = callout.querySelector<HTMLElement>(':scope > .callout-title > .callout-icon');
    if (!icon || icon.dataset.subnotesEditInitialized === 'true') return;

    icon.dataset.subnotesEditInitialized = 'true';
    icon.classList.add('obsidian-subnotes-edit-icon');
    icon.setAttribute('role', 'button');
    icon.setAttribute('tabindex', '0');
    icon.setAttribute('aria-label', 'Édition');
    icon.setAttribute('title', 'Édition');

    const open = (event: Event) => {
      event.preventDefault();
      event.stopPropagation();

      const linkPath = embed.getAttribute('src');
      if (!linkPath) return;

      const sourcePath =
        callout.dataset.subnotesSourcePath ??
        embed.dataset.subnotesSourcePath ??
        this.app.workspace.getActiveFile()?.path ??
        '';
      const file = this.resolveLinkedFile(linkPath, sourcePath);
      if (file) void this.openSubnote(file);
    };

    this.registerDomEvent(icon, 'click', open);
    this.registerDomEvent(icon, 'keydown', (event: KeyboardEvent) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      open(event);
    });
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
    toggle.setAttribute('title', collapsed ? 'Déplier' : 'Plier');
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
    const pattern =
      /^>\s*\[!note\](?:[+-])?[^\r\n]*\r?\n>\s*!\[\[([^\r\n]*?)\]\]/gm;

    return markdown.replace(
      pattern,
      (fullMatch: string, rawLink: string) => {
        const target = this.resolveLinkedFile(rawLink, parentFile.path);
        if (!target || !this.isSubnoteFile(target, parentFile)) return fullMatch;

        const content = this.markdownContentCache.get(target.path);
        if (content === undefined) return fullMatch;

        return content.replace(/\s+$/u, '');
      },
    );
  }

  private showSubnoteContextMenu(event: MouseEvent): void {
    const target = event.target;
    if (!(target instanceof Element)) return;

    const callout = target.closest<HTMLElement>('.obsidian-subnotes-callout, .callout');
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
        .setTitle('Éditer')
        .setIcon('pencil')
        .onClick(() => void this.openSubnote(file)),
    );

    const parentFile = this.app.vault.getAbstractFileByPath(sourcePath);
    if (parentFile instanceof TFile) {
      menu.addItem((item) =>
        item
          .setTitle('Modifier le titre affiché')
          .setIcon('text-cursor-input')
          .onClick(() => void this.promptVisibleTitle(parentFile, linkPath)),
      );
    }

    if (fold) {
      const collapsed = this.isFoldCollapsed(fold.host, fold.content);
      menu.addItem((item) =>
        item
          .setTitle(collapsed ? 'Déplier' : 'Plier')
          .setIcon(collapsed ? 'chevron-down' : 'chevron-up')
          .onClick(() => {
            this.setFoldCollapsed(fold.host, fold.content, !collapsed);
            this.refreshFoldIcon(fold.host);
          }),
      );
    }

    menu.showAtMouseEvent(event);
  }

  private async promptVisibleTitle(parentFile: TFile, rawLink: string): Promise<void> {
    const currentTitle = await this.getVisibleTitle(parentFile, rawLink);
    new SubnoteTitleModal(this.app, currentTitle, (title) => {
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

  private async openSubnote(file: TFile): Promise<void> {
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
      const pattern =
        /^> \[!note\](?:[+-])?([^\r\n]*)\r?\n> !\[\[([^\r\n]*?)\]\]/gm;

      return content.replace(
        pattern,
        (fullMatch: string, title: string, rawLink: string) => {
          const target = this.resolveLinkedFile(rawLink, parentFile.path);
          if (!target || !this.isSubnoteFile(target, parentFile)) return fullMatch;

          return `> [!note]${foldMarker}${title}\n> ![[${rawLink}]]`;
        },
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

  private insertBlock(editor: Editor, block: string): void {
    const cursor = editor.getCursor();
    const line = editor.getLine(cursor.line);
    const before = cursor.ch === 0 && line.length === 0 ? '' : '\n';
    const after = '\n\n';

    editor.replaceSelection(`${before}${block}${after}`);
  }
}
