type NetworkNavigator = Navigator & {
  connection?: EventTarget;
  mozConnection?: EventTarget;
  webkitConnection?: EventTarget;
};

/** NetworkInformation is optional on Safari. Actual requests decide reachability. */
export function subscribeNetworkChanges(listener: () => void): () => void {
  const source = navigator as NetworkNavigator;
  const network = source.connection ?? source.mozConnection ?? source.webkitConnection;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastChange = 0;
  const notify = () => {
    if (timer) return;
    timer = setTimeout(
      () => {
        timer = undefined;
        lastChange = Date.now();
        listener();
      },
      Math.max(600, lastChange + 15_000 - Date.now()),
    );
  };
  const online = () => {
    clearTimeout(timer);
    timer = undefined;
    lastChange = 0;
    notify();
  };
  window.addEventListener('online', online);
  network?.addEventListener('change', notify);
  return () => {
    clearTimeout(timer);
    window.removeEventListener('online', online);
    network?.removeEventListener('change', notify);
  };
}

/** Also releases the caller if a browser fetch or test transport ignores cancellation. */
export function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new DOMException('Request aborted', 'AbortError'));
    if (signal.aborted) {
      void promise.catch(() => {});
      abort();
      return;
    }
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
