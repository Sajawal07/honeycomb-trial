export type PointerKind = 'down' | 'move' | 'up' | 'hover';

export type PointerHandler = (type: PointerKind, x: number, y: number, pointerType: string) => void;

/**
 * PointerInput
 * Unified touch / mouse / stylus input via the Pointer Events API.
 * - Tracks a single active pointer (extra fingers are ignored).
 * - Uses coalesced events for dense, accurate needle paths.
 * - Converts client coordinates into the canvas' logical (CSS px) space,
 *   correcting for any CSS scaling of the canvas element.
 */
export class PointerInput {
  private el: HTMLCanvasElement;
  private handler: PointerHandler;
  private getLogicalSize: () => { w: number; h: number };
  private activeId: number | null = null;
  private activeType = 'mouse';
  private listeners: Array<[string, EventListener]> = [];

  constructor(el: HTMLCanvasElement, getLogicalSize: () => { w: number; h: number }, handler: PointerHandler) {
    this.el = el;
    this.handler = handler;
    this.getLogicalSize = getLogicalSize;
    this.on('pointerdown', (e) => this.onDown(e as PointerEvent));
    this.on('pointermove', (e) => this.onMove(e as PointerEvent));
    this.on('pointerup', (e) => this.onUp(e as PointerEvent));
    this.on('pointercancel', (e) => this.onUp(e as PointerEvent));
    this.on('lostpointercapture', (e) => this.onUp(e as PointerEvent));
    this.on('contextmenu', (e) => e.preventDefault());
  }

  private on(type: string, fn: EventListener): void {
    this.el.addEventListener(type, fn, { passive: false });
    this.listeners.push([type, fn]);
  }

  private toLocal(clientX: number, clientY: number): { x: number; y: number } {
    const rect = this.el.getBoundingClientRect();
    const { w, h } = this.getLogicalSize();
    const sx = rect.width > 0 ? w / rect.width : 1;
    const sy = rect.height > 0 ? h / rect.height : 1;
    return { x: (clientX - rect.left) * sx, y: (clientY - rect.top) * sy };
  }

  private onDown(e: PointerEvent): void {
    if (this.activeId !== null) return; // ignore additional fingers
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    this.activeId = e.pointerId;
    this.activeType = e.pointerType || 'mouse';
    try {
      this.el.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    const p = this.toLocal(e.clientX, e.clientY);
    this.handler('down', p.x, p.y, this.activeType);
  }

  private onMove(e: PointerEvent): void {
    if (this.activeId === null) {
      if (e.pointerType === 'mouse') {
        const p = this.toLocal(e.clientX, e.clientY);
        this.handler('hover', p.x, p.y, 'mouse');
      }
      return;
    }
    if (e.pointerId !== this.activeId) return;
    e.preventDefault();
    const list = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
    const events = list.length > 0 ? list : [e];
    for (const ce of events) {
      const p = this.toLocal(ce.clientX, ce.clientY);
      this.handler('move', p.x, p.y, this.activeType);
    }
  }

  private onUp(e: PointerEvent): void {
    if (e.pointerId !== this.activeId) return;
    const p = this.toLocal(e.clientX, e.clientY);
    this.activeId = null;
    try {
      if (this.el.hasPointerCapture(e.pointerId)) this.el.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    this.handler('up', p.x, p.y, this.activeType);
  }

  /** Forcefully drop the active pointer (pause / background). */
  cancel(): void {
    if (this.activeId !== null) {
      try {
        if (this.el.hasPointerCapture(this.activeId)) this.el.releasePointerCapture(this.activeId);
      } catch {
        /* ignore */
      }
    }
    this.activeId = null;
  }

  get isDown(): boolean {
    return this.activeId !== null;
  }

  destroy(): void {
    for (const [type, fn] of this.listeners) this.el.removeEventListener(type, fn);
    this.listeners = [];
  }
}
