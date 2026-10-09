// 修改点：首个窗口必须同时等到原生首帧与页面布局完成，避免挂载时提前显示。
export class WindowPresentation {
  private rendererReady = false;
  private paintReady = false;
  private presented = false;
  constructor(private allowed: boolean, private readonly show: (focus: boolean) => void, private explicit = false) {}

  rendererDidPrepare(): void { this.rendererReady = true; this.presentInitial(); }
  windowDidPaint(): void { this.paintReady = true; this.presentInitial(); }

  requestOpen(): void {
    this.allowed = true;
    this.explicit = true;
    if (!this.rendererReady || !this.paintReady) return;
    this.presented = true;
    this.show(true);
  }

  private presentInitial(): void {
    if (!this.allowed || !this.rendererReady || !this.paintReady || this.presented) return;
    this.presented = true;
    this.show(this.explicit);
  }
}
