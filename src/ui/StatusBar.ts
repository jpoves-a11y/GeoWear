// ============================================================
// GeoWear — StatusBar
// Progress and status display management
// ============================================================

export class StatusBar {
  private statusText: HTMLElement;
  private loadingOverlay: HTMLElement;
  private loadingText: HTMLElement;

  constructor() {
    this.statusText = document.getElementById('status-text')!;
    this.loadingOverlay = document.getElementById('loading-overlay')!;
    this.loadingText = document.getElementById('loading-text')!;
  }

  setStatus(text: string): void {
    this.statusText.textContent = text;
  }

  showLoading(text: string = 'Processing...'): void {
    this.loadingOverlay.classList.remove('hidden');
    this.loadingText.textContent = text;
  }

  hideLoading(): void {
    this.loadingOverlay.classList.add('hidden');
  }

  setProgress(progress: number, text?: string): void {
    if (text) {
      this.loadingText.textContent = text;
    }
  }

  setFileInfo(text: string): void {
    const fileInfo = document.getElementById('file-info');
    if (fileInfo) {
      fileInfo.querySelector('.file-label')!.textContent = text;
    }
  }

  setMeshInfo(text: string): void {
    const meshInfo = document.getElementById('mesh-info');
    if (meshInfo) {
      meshInfo.textContent = text;
    }
  }
}
