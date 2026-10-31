import { App } from '@capacitor/app';
import { Capacitor, type PluginListenerHandle } from '@capacitor/core';
import { Haptics, ImpactStyle, NotificationType } from '@capacitor/haptics';
import { StatusBar, Style } from '@capacitor/status-bar';

/**
 * Platform bridge: Capacitor plugins on Android, graceful web fallbacks.
 */
export class Platform {
  vibrationEnabled = true;
  private handles: PluginListenerHandle[] = [];
  readonly native = Capacitor.isNativePlatform();

  async init(onBack: () => void, onAppState: (active: boolean) => void): Promise<void> {
    if (!this.native) return;
    try {
      await StatusBar.setOverlaysWebView({ overlay: false });
      await StatusBar.setStyle({ style: Style.Dark });
      await StatusBar.setBackgroundColor({ color: '#141110' });
    } catch {
      /* status bar plugin unavailable */
    }
    try {
      this.handles.push(await App.addListener('backButton', () => onBack()));
      this.handles.push(await App.addListener('appStateChange', (s) => onAppState(s.isActive)));
    } catch {
      /* app plugin unavailable */
    }
  }

  exitApp(): void {
    if (this.native) void App.exitApp();
  }

  impact(strength: 'light' | 'medium' | 'heavy'): void {
    if (!this.vibrationEnabled) return;
    if (this.native) {
      const style = strength === 'heavy' ? ImpactStyle.Heavy : strength === 'medium' ? ImpactStyle.Medium : ImpactStyle.Light;
      void Haptics.impact({ style }).catch(() => undefined);
    } else if ('vibrate' in navigator) {
      try {
        navigator.vibrate(strength === 'heavy' ? 60 : strength === 'medium' ? 30 : 12);
      } catch {
        /* ignore */
      }
    }
  }

  notify(kind: 'success' | 'error'): void {
    if (!this.vibrationEnabled) return;
    if (this.native) {
      void Haptics.notification({ type: kind === 'success' ? NotificationType.Success : NotificationType.Error }).catch(() => undefined);
    } else if ('vibrate' in navigator) {
      try {
        navigator.vibrate(kind === 'success' ? [20, 40, 20] : [80, 40, 120]);
      } catch {
        /* ignore */
      }
    }
  }

  destroy(): void {
    for (const h of this.handles) void h.remove();
    this.handles = [];
  }
}
