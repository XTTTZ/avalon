import { useEffect, useRef, useState } from 'react';
import { Download, Monitor, Moon, Settings2, Share, Sun, X } from 'lucide-react';
import { useTheme, type ThemePreference } from '../theme';

interface InstallPrompt extends Event {
  prompt(): Promise<unknown>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}
const appMode = () =>
  Boolean((navigator as Navigator & { standalone?: boolean }).standalone) ||
  window.matchMedia('(display-mode: standalone), (display-mode: fullscreen)').matches;

export function Preferences() {
  const dialog = useRef<HTMLDialogElement>(null);
  const { preference, setPreference } = useTheme();
  const [installed, setInstalled] = useState(appMode);
  const [prompt, setPrompt] = useState<InstallPrompt | null>(null);
  const [busy, setBusy] = useState(false);
  const isApple =
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isEmbedded = /MicroMessenger|FBAN|FBAV|Instagram/i.test(navigator.userAgent);

  useEffect(() => {
    const beforeInstall = (event: Event) => {
      event.preventDefault();
      setPrompt(event as InstallPrompt);
    };
    const onInstalled = () => {
      setPrompt(null);
      setInstalled(true);
    };
    const modes = window.matchMedia('(display-mode: standalone), (display-mode: fullscreen)');
    const onMode = () => setInstalled(appMode());
    window.addEventListener('beforeinstallprompt', beforeInstall);
    window.addEventListener('appinstalled', onInstalled);
    modes.addEventListener('change', onMode);
    return () => {
      window.removeEventListener('beforeinstallprompt', beforeInstall);
      window.removeEventListener('appinstalled', onInstalled);
      modes.removeEventListener('change', onMode);
    };
  }, []);

  const install = async () => {
    if (!prompt || busy) return;
    setBusy(true);
    try {
      await prompt.prompt();
      await prompt.userChoice;
    } catch {
      // Browser can withdraw the offer; manual instructions remain available.
    } finally {
      setPrompt(null);
      setBusy(false);
    }
  };
  const themes = [
    ['system', '跟随系统', Monitor],
    ['light', '浅色', Sun],
    ['dark', '深色', Moon],
  ] as const;

  return (
    <>
      <button
        className="icon-button"
        aria-label="外观与安装"
        onClick={() => dialog.current?.showModal()}
      >
        <Settings2 size={20} />
      </button>
      <dialog
        ref={dialog}
        className="preferences-dialog"
        aria-labelledby="preferences-title"
        onClick={(event) => {
          if (event.target === event.currentTarget) dialog.current?.close();
        }}
      >
        <div className="modal-top">
          <h2 id="preferences-title">外观与安装</h2>
          <button
            className="icon-button"
            aria-label="关闭外观设置"
            onClick={() => dialog.current?.close()}
          >
            <X size={20} />
          </button>
        </div>
        <div className="theme-options" role="group" aria-label="外观模式">
          {themes.map(([value, label, Icon]) => (
            <button
              key={value}
              type="button"
              aria-pressed={preference === value}
              onClick={() => setPreference(value as ThemePreference)}
            >
              <Icon size={20} />
              <span>{label}</span>
            </button>
          ))}
        </div>
        <section className="install-section" aria-label="添加到主屏幕">
          <div className="install-heading">
            <img
              src={`${import.meta.env.BASE_URL}icons/icon-192.png`}
              alt=""
              width={48}
              height={48}
            />
            <div>
              <h3>阿瓦隆圆桌</h3>
              <p>{installed ? '已在应用模式中打开' : '添加到主屏幕'}</p>
            </div>
          </div>
          {!installed &&
            (prompt ? (
              <button
                className="button primary full"
                disabled={busy}
                onClick={() => void install()}
              >
                <Download size={18} />
                {busy ? '正在打开安装…' : '安装应用'}
              </button>
            ) : isEmbedded ? (
              <p className="install-guide">
                用 {isApple ? 'Safari' : 'Chrome'} 打开本页，再添加到主屏幕。
              </p>
            ) : isApple ? (
              <p className="install-guide">
                点击 <Share size={16} aria-label="分享" /> 分享，选择「添加到主屏幕」。
              </p>
            ) : (
              <p className="install-guide">打开浏览器菜单，选择「安装应用」或「添加到主屏幕」。</p>
            ))}
        </section>
      </dialog>
    </>
  );
}
