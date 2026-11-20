import { useEffect, useRef, useState } from 'react';
import { Modal } from '../components/ui';
import type { DesignDoc, SlideSize } from './model';

/**
 * Plays the slide exactly as a TV will: inside the real live page (`/live.html`), fed the slide
 * currently in the editor - saved or not - so animations and widgets can be checked before
 * publishing. "Replay" reloads the frame so entrance animations run again from the start.
 */
export function LivePreview({ doc, size, name, media, onClose }: {
  doc: DesignDoc; size: SlideSize; name: string; media: Record<string, string>; onClose: () => void;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [run, setRun] = useState(0);

  // The page asks for its data once it has loaded (it has no link to fetch from in preview mode).
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== window.location.origin || e.source !== frame.current?.contentWindow) return;
      if ((e.data as { type?: string } | null)?.type !== 'gm-live-ready') return;
      frame.current?.contentWindow?.postMessage(
        { type: 'gm-live-doc', data: { name, width: size.width, height: size.height, version: 0, document: doc, media } },
        window.location.origin,
      );
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [doc, size, name, media]);

  const portrait = size.height > size.width;
  return (
    <Modal wide title="Live preview" onClose={onClose}
      actions={(
        <>
          <span className="muted dz-preview-note">Plays like it will on the TV. Weather and clock need internet.</span>
          <button type="button" className="btn" onClick={() => setRun((n) => n + 1)}>Replay</button>
          <button type="button" className="btn btn-primary" onClick={onClose}>Close</button>
        </>
      )}>
      <div className={`dz-preview-box${portrait ? ' portrait' : ''}`}>
        <iframe key={run} ref={frame} title="Live preview" src="/live.html?preview=1" sandbox="allow-scripts allow-same-origin" />
      </div>
    </Modal>
  );
}
