import { AbstractInputSuggest, App, Modal, Setting } from 'obsidian';
import { InterfaceLanguage, translate } from './i18n';
import type { SubnoteStorageType } from './settings';

class FilenameInputSuggest extends AbstractInputSuggest<string> {
  constructor(
    app: App,
    inputEl: HTMLInputElement,
    private readonly getItems: () => string[],
  ) {
    super(app, inputEl);
    this.limit = 50;
  }

  protected getSuggestions(query: string): string[] {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    if (!normalizedQuery) return this.getItems().slice(0, this.limit);

    return this.getItems()
      .map((item) => ({
        item,
        path: item.toLocaleLowerCase(),
        name: item.split('/').pop()?.toLocaleLowerCase() ?? '',
      }))
      .filter(({ path, name }) =>
        path.includes(normalizedQuery) || name.includes(normalizedQuery),
      )
      .sort((a, b) => {
        const aStarts = a.path.startsWith(normalizedQuery) || a.name.startsWith(normalizedQuery);
        const bStarts = b.path.startsWith(normalizedQuery) || b.name.startsWith(normalizedQuery);
        if (aStarts !== bStarts) return aStarts ? -1 : 1;
        return a.path.localeCompare(b.path);
      })
      .map(({ item }) => item)
      .slice(0, this.limit);
  }

  renderSuggestion(value: string, el: HTMLElement): void {
    el.setText(value);
  }
}

export class SubnoteNameModal extends Modal {
  private title = '';
  private filename = '';
  private filenameFollowsTitle = true;
  private storageType: SubnoteStorageType;
  private filenameSuggest: FilenameInputSuggest | null = null;

  constructor(
    app: App,
    private readonly language: InterfaceLanguage,
    defaultStorageType: SubnoteStorageType,
    private readonly suggestFilename: (title: string) => string,
    private readonly makeFilenameAvailable: (filename: string) => string,
    private readonly getFilenameSuggestions: () => string[],
    private readonly onSubmit: (
      title: string,
      storageType: SubnoteStorageType,
      filename?: string,
    ) => void,
  ) {
    super(app);
    this.storageType = defaultStorageType;
  }

  onOpen(): void {
    const { contentEl } = this;
    const text = (key: Parameters<typeof translate>[1]): string =>
      translate(this.language, key);

    new Setting(contentEl).setName(text('newSubnoteHeading')).setHeading();

    let filenameInputEl: HTMLInputElement | null = null;

    const updateSuggestedFilename = (): void => {
      if (!filenameInputEl || !this.filenameFollowsTitle) return;
      this.filename = this.suggestFilename(this.title);
      filenameInputEl.value = this.filename;
    };

    new Setting(contentEl)
      .setName(text('titleName'))
      .setDesc(text('titleDesc'))
      .addText((input) => {
        input
          .setPlaceholder(translate(this.language, 'subnoteNamePlaceholder'))
          .onChange((value) => {
            this.title = value;
            updateSuggestedFilename();
          });

        input.inputEl.addEventListener('keydown', (event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            this.submit();
          }
        });

        window.setTimeout(() => input.inputEl.focus(), 0);
      });

    const filenameSetting = new Setting(contentEl)
      .setName(text('filenameLabel'))
      .addText((input) => {
        filenameInputEl = input.inputEl;
        input
          .setPlaceholder(text('filenamePlaceholder'))
          .onChange((value) => {
            this.filename = value;
            this.filenameFollowsTitle = false;
          });

        input.inputEl.addEventListener('blur', () => {
          this.filename = this.makeFilenameAvailable(this.filename || this.title);
          input.setValue(this.filename);
        });

        input.inputEl.addEventListener('keydown', (event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            this.submit();
          }
        });

        this.filenameSuggest = new FilenameInputSuggest(
          this.app,
          input.inputEl,
          this.getFilenameSuggestions,
        );
        this.filenameSuggest.onSelect((value) => {
          this.filename = value;
          this.filenameFollowsTitle = false;
          input.setValue(value);
        });
      });

    new Setting(contentEl)
      .setName(text('typeLabel'))
      .addDropdown((dropdown) =>
        dropdown
          .addOption('virtual', text('virtualOption'))
          .addOption('file', text('fileOption'))
          .setValue(this.storageType)
          .onChange((value) => {
            this.storageType = value as SubnoteStorageType;
            filenameSetting.settingEl.toggle(this.storageType === 'file');
            if (this.storageType === 'file' && !this.filename) {
              this.filenameFollowsTitle = true;
              updateSuggestedFilename();
            }
          }),
      )
      .addButton((button) =>
        button
          .setButtonText(text('createButton'))
          .setCta()
          .onClick(() => this.submit()),
      );

    filenameSetting.settingEl.toggle(this.storageType === 'file');
  }

  onClose(): void {
    this.filenameSuggest?.close();
    this.filenameSuggest = null;
    this.contentEl.empty();
  }

  private submit(): void {
    const title = this.title.trim();
    if (!title) return;

    if (this.storageType === 'file' && /[\\/]$/u.test(this.filename.trim())) return;

    const filename = this.storageType === 'file'
      ? this.makeFilenameAvailable(this.filename || title)
      : undefined;
    if (this.storageType === 'file' && !filename) return;

    this.close();
    this.onSubmit(title, this.storageType, filename);
  }
}
