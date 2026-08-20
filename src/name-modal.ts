import { App, Modal, Setting } from 'obsidian';
import { InterfaceLanguage, translate } from './i18n';
import type { SubnoteStorageType } from './settings';

export class SubnoteNameModal extends Modal {
  private value = '';
  private storageType: SubnoteStorageType;

  constructor(
    app: App,
    private readonly language: InterfaceLanguage,
    defaultStorageType: SubnoteStorageType,
    private readonly onSubmit: (name: string, storageType: SubnoteStorageType) => void,
  ) {
    super(app);
    this.storageType = defaultStorageType;
  }

  onOpen(): void {
    const { contentEl } = this;
    const text = (key: Parameters<typeof translate>[1]): string =>
      translate(this.language, key);

    contentEl.createEl('h3', { text: text('newSubnoteHeading') });

    new Setting(contentEl)
      .setName(text('nameLabel'))
      .addText((text) => {
        text
          .setPlaceholder(translate(this.language, 'subnoteNamePlaceholder'))
          .onChange((value) => {
            this.value = value;
          });

        text.inputEl.addEventListener('keydown', (event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            this.submit();
          }
        });

        window.setTimeout(() => text.inputEl.focus(), 0);
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
          }),
      );

    new Setting(contentEl).addButton((button) =>
      button
        .setButtonText(text('createButton'))
        .setCta()
        .onClick(() => this.submit()),
    );
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private submit(): void {
    const name = this.value.trim();
    if (!name) return;

    this.close();
    this.onSubmit(name, this.storageType);
  }
}
