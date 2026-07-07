// ============================================================
// GeoWear — SaveDialog
// Custom HTML/CSS modal dialogs for the Excel save flow.
// All methods return Promises so callers can await them cleanly.
// ============================================================

// ---------------------------------------------------------------------------
// Styles (injected once into <head>)
// ---------------------------------------------------------------------------

const DIALOG_CSS = `
.gw-overlay {
  position: fixed; inset: 0;
  background: rgba(0, 0, 0, 0.6);
  z-index: 10000;
  display: flex; align-items: center; justify-content: center;
}
.gw-dialog {
  background: #1e1e1e;
  border: 1px solid #444;
  border-radius: 8px;
  padding: 24px 28px;
  min-width: 340px;
  max-width: 500px;
  width: 90vw;
  color: #d4d4d4;
  font-family: system-ui, sans-serif;
  font-size: 14px;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.7);
}
.gw-dialog h3 {
  margin: 0 0 10px;
  font-size: 15px;
  font-weight: 600;
  color: #ffffff;
}
.gw-dialog p {
  margin: 0 0 20px;
  line-height: 1.55;
  color: #b0b0b0;
}
.gw-dialog input[type="text"] {
  display: block;
  width: 100%;
  box-sizing: border-box;
  padding: 8px 10px;
  background: #2a2a2a;
  border: 1px solid #555;
  border-radius: 4px;
  color: #d4d4d4;
  font-size: 14px;
  margin-bottom: 20px;
  outline: none;
}
.gw-dialog input[type="text"]:focus {
  border-color: #0078d4;
}
.gw-btns {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
  flex-wrap: wrap;
}
.gw-btn {
  padding: 7px 18px;
  border-radius: 4px;
  border: none;
  cursor: pointer;
  font-size: 13px;
  font-weight: 500;
  transition: opacity 0.15s;
}
.gw-btn:hover { opacity: 0.82; }
.gw-btn.primary   { background: #0078d4; color: #fff; }
.gw-btn.secondary { background: #3a3a3a; color: #ccc; border: 1px solid #555; }
.gw-btn.danger    { background: #c42b1c; color: #fff; }
`;

function injectStyles(): void {
  if (document.getElementById('gw-dialog-styles')) return;
  const style = document.createElement('style');
  style.id = 'gw-dialog-styles';
  style.textContent = DIALOG_CSS;
  document.head.appendChild(style);
}

// ---------------------------------------------------------------------------
// Low-level modal builder
// ---------------------------------------------------------------------------

interface ButtonDef {
  label: string;
  value: string;
  style: 'primary' | 'secondary' | 'danger';
}

interface ModalResult {
  choice: string;
  inputValue?: string;
}

function showModal(
  title: string,
  message: string,
  buttons: ButtonDef[],
  inputField?: { placeholder: string; defaultValue: string },
): Promise<ModalResult> {
  injectStyles();

  return new Promise((resolve) => {
    // -- Overlay --
    const overlay = document.createElement('div');
    overlay.className = 'gw-overlay';

    // -- Dialog box --
    const dialog = document.createElement('div');
    dialog.className = 'gw-dialog';

    const h3 = document.createElement('h3');
    h3.textContent = title;
    dialog.appendChild(h3);

    const p = document.createElement('p');
    p.textContent = message;
    dialog.appendChild(p);

    // Optional text input
    let input: HTMLInputElement | null = null;
    if (inputField) {
      input = document.createElement('input');
      input.type = 'text';
      input.placeholder = inputField.placeholder;
      input.value = inputField.defaultValue;
      dialog.appendChild(input);
    }

    // Buttons
    const btnRow = document.createElement('div');
    btnRow.className = 'gw-btns';

    const close = (choice: string) => {
      document.body.removeChild(overlay);
      resolve({ choice, inputValue: input?.value });
    };

    for (const def of buttons) {
      const btn = document.createElement('button');
      btn.className = `gw-btn ${def.style}`;
      btn.textContent = def.label;
      btn.onclick = () => close(def.value);
      btnRow.appendChild(btn);
    }
    dialog.appendChild(btnRow);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    // Keyboard handling
    if (input) {
      input.focus();
      input.select();
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          const primary = btnRow.querySelector<HTMLButtonElement>('.primary');
          primary?.click();
        } else if (e.key === 'Escape') {
          // Click the last button (conventionally Cancel)
          const last = btnRow.querySelectorAll<HTMLButtonElement>('.gw-btn');
          last[last.length - 1]?.click();
        }
      });
    } else {
      // Focus the primary button
      const primary = btnRow.querySelector<HTMLButtonElement>('.primary');
      primary?.focus();

      const onKey = (e: KeyboardEvent) => {
        if (e.key === 'Escape') {
          window.removeEventListener('keydown', onKey);
          const all = btnRow.querySelectorAll<HTMLButtonElement>('.gw-btn');
          all[all.length - 1]?.click();
        }
      };
      window.addEventListener('keydown', onKey, { once: true });
    }
  });
}

// ---------------------------------------------------------------------------
// Public dialog class
// ---------------------------------------------------------------------------

export class SaveDialog {
  /**
   * Ask the user whether to save results before loading a new STL.
   * Returns true → user wants to save.
   */
  async askWantToSave(prosthesisName: string): Promise<boolean> {
    const { choice } = await showModal(
      'Cambio de prótesis',
      `Hay resultados de análisis para "${prosthesisName}". ¿Desea guardar los datos antes de cargar una nueva prótesis?`,
      [
        { label: 'Guardar', value: 'yes', style: 'primary' },
        { label: 'No guardar', value: 'no', style: 'secondary' },
      ],
    );
    return choice === 'yes';
  }

  /**
   * Ask whether to create a new Excel file or append to an existing one.
   */
  async askCreateOrAppend(): Promise<'create' | 'append' | 'cancel'> {
    const { choice } = await showModal(
      'Guardar datos',
      '¿Desea crear un archivo Excel nuevo o añadir los datos a un archivo existente?',
      [
        { label: 'Crear nuevo', value: 'create', style: 'primary' },
        { label: 'Añadir a existente', value: 'append', style: 'secondary' },
        { label: 'Cancelar', value: 'cancel', style: 'danger' },
      ],
    );
    return choice as 'create' | 'append' | 'cancel';
  }

  /**
   * Ask the user for the name of the new file.
   * Returns null if the user cancels.
   */
  async askFileName(defaultName: string): Promise<string | null> {
    const { choice, inputValue } = await showModal(
      'Nombre del archivo',
      'Introduzca el nombre del archivo Excel (sin extensión):',
      [
        { label: 'Guardar', value: 'ok', style: 'primary' },
        { label: 'Cancelar', value: 'cancel', style: 'secondary' },
      ],
      { placeholder: 'nombre_archivo', defaultValue: defaultName },
    );
    if (choice === 'cancel' || !inputValue?.trim()) return null;
    return inputValue.trim();
  }

  /**
   * Ask the user to pick an existing .xlsx file.
   *
   * Uses the File System Access API when available (Chrome/Edge) so the returned
   * FileSystemFileHandle can later be used for an in-place write (no download).
   * Falls back to a hidden <input type="file"> on unsupported browsers.
   *
   * Returns null if the user cancels.
   */
  async askPickExistingFile(): Promise<{ file: File; handle?: FileSystemFileHandle } | null> {
    // --- File System Access API (Chrome / Edge) ---
    if ('showOpenFilePicker' in window) {
      try {
        const [handle]: FileSystemFileHandle[] = await (window as any).showOpenFilePicker({
          types: [
            {
              description: 'Excel',
              accept: {
                'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'],
              },
            },
          ],
          multiple: false,
        });
        const file: File = await handle.getFile();
        return { file, handle };
      } catch {
        // User closed the native picker
        return null;
      }
    }

    // --- Fallback: hidden <input type="file"> ---
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.xlsx';

      let resolved = false;
      const done = (value: { file: File; handle?: FileSystemFileHandle } | null) => {
        if (!resolved) { resolved = true; resolve(value); }
      };

      input.onchange = () => {
        const f = input.files?.[0];
        done(f ? { file: f } : null);
      };

      // When the OS file dialog closes without a selection the window regains
      // focus — use that to resolve null after a short delay.
      window.addEventListener(
        'focus',
        () => setTimeout(() => done(null), 400),
        { once: true },
      );

      input.click();
    });
  }

  /**
   * Open a native Save File Picker (File System Access API).
   * Allows the user to choose an exact location to write the new file in-place.
   *
   * Returns the FileSystemFileHandle on success, or null when:
   *  - The API is not available (Firefox, Safari) → caller should fall back to download.
   *  - The user cancels the picker.
   */
  async askSaveFilePicker(suggestedName: string): Promise<FileSystemFileHandle | null> {
    if (!('showSaveFilePicker' in window)) return null;
    try {
      const handle: FileSystemFileHandle = await (window as any).showSaveFilePicker({
        suggestedName: suggestedName.endsWith('.xlsx') ? suggestedName : `${suggestedName}.xlsx`,
        types: [
          {
            description: 'Excel',
            accept: {
              'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'],
            },
          },
        ],
      });
      return handle;
    } catch {
      return null;
    }
  }

  /**
   * Inform the user that the prosthesis name already exists and ask whether
   * to overwrite its data or skip saving.
   */
  async askOverwriteOrSkip(prosthesisName: string): Promise<'overwrite' | 'skip'> {
    const { choice } = await showModal(
      'Prótesis ya existe',
      `Ya existe una entrada para "${prosthesisName}" en el archivo. ¿Desea reemplazar sus datos?`,
      [
        { label: 'Reemplazar', value: 'overwrite', style: 'primary' },
        { label: 'Cancelar', value: 'skip', style: 'secondary' },
      ],
    );
    return choice as 'overwrite' | 'skip';
  }
}
