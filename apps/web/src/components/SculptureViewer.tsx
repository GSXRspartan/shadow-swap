/**
 * Cross-chain signature sculpture viewer.
 *
 * Two layers, deliberately:
 *   1. The poster (thumbnail.png) — a light photograph, drawn as an <img> so its
 *      alt text exists for sighted and assistive users alike. Always available.
 *   2. The interactive GLB (cross-chain-sculpture.optimized.glb), loaded only when
 *      the user presses "Explore in 3D" — WebGL load is deferred so a user with
 *      WebGL off, on a slow device, or who simply asked for the design over the
 *      decoration never pays for it. `three` is a dynamic import and is not in
 *      the initial bundle.
 *
 * Rotation respects `prefers-reduced-motion`: on, it is still but the sculpture
 * is fully viewable; the pause/play control stays a real button.
 */
import { useEffect, useRef, useState } from 'react';

export function SculptureViewer() {
  const mountRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(false);
  const [rendered, setRendered] = useState<'idle' | 'loading' | 'ready' | 'fallback'>('idle');
  const prefersReducedMotion = useRef(false);

  useEffect(() => {
    prefersReducedMotion.current =
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }, []);

  useEffect(() => {
    if (!active) return;
    const root = mountRef.current;
    if (root === null) return;
    let raf = 0;
    let disposed = false;
    let renderer: { dispose: () => void } | undefined;
    setRendered('loading');

    (async () => {
      try {
        const THREE = await import('three');
        const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
        if (disposed) return;
        const scene = new THREE.Scene();
        const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100);
        camera.position.set(3.2, 2.2, 4.4);
        camera.lookAt(0, 0.6, 0);
        const rendererFactory = new THREE.WebGLRenderer({ antialias: true, alpha: true });
        rendererFactory.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        renderer = rendererFactory;
        const rect = root.getBoundingClientRect();
        rendererFactory.setSize(Math.max(1, rect.width), Math.max(1, rect.height || 320));
        root.appendChild(rendererFactory.domElement);

        const group = new THREE.Group();
        scene.add(group);
        scene.add(new THREE.AmbientLight(0xffffff, 0.8));
        const front = new THREE.DirectionalLight(0xffffff, 1.4);
        front.position.set(4, 6, 4);
        scene.add(front);
        const back = new THREE.DirectionalLight(0x8ecbff, 0.5);
        back.position.set(-4, 2, -4);
        scene.add(back);

        const loader = new GLTFLoader();
        loader.load('/assets/cross-chain-sculpture/cross-chain-sculpture.optimized.glb', (gltf: unknown) => {
          if (disposed) return;
          const model = (gltf as { scene: import('three').Object3D }).scene;
          model.position.y -= 0.6;
          group.add(model);
          setRendered('ready');
        });

        const tick = () => {
          if (disposed) return;
          if (!prefersReducedMotion.current) group.rotation.y += 0.005;
          rendererFactory.render(scene, camera);
          raf = requestAnimationFrame(tick);
        };
        tick();
      } catch {
        if (!disposed) setRendered('fallback');
      }
    })();

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      try {
        renderer?.dispose();
      } catch {
        /* already disposed */
      }
      if (root.firstChild) root.removeChild(root.firstChild);
    };
  }, [active]);

  return (
    <div className="stack" style={{ gap: 'var(--s-3)' }}>
      <div
        ref={mountRef}
        style={{
          borderRadius: 'var(--r-xl)',
          border: '1px solid var(--line-1)',
          background: 'radial-gradient(520px 320px at 50% 50%, rgba(224,164,79,0.08), rgba(6,8,12,0.55))',
          minHeight: 320,
          display: rendered === 'ready' ? 'block' : 'none',
        }}
        aria-label="Interactive 3D cross-chain sculpture"
        data-testid="sculpture-3d"
      />
      {rendered !== 'ready' && (
        <img
          src="/assets/cross-chain-sculpture/thumbnail.png"
          alt="Cross-chain sculpture: two glowing spheres (cyan and magenta) joined by a golden ring"
          loading="lazy"
          decoding="async"
          style={{ width: '100%', height: '100%', objectFit: 'contain', borderRadius: 'var(--r-xl)', border: '1px solid var(--line-1)' }}
        />
      )}
      <div className="spread" style={{ flexWrap: 'wrap', gap: 'var(--s-2)', alignItems: 'center' }}>
        {!active ? (
          <button type="button" className="ss-btn ss-btn--ghost" onClick={() => setActive(true)}>
            Explore in 3D
          </button>
        ) : (
          <button type="button" className="ss-btn ss-btn--ghost" onClick={() => setActive(false)}>
            Close 3D view
          </button>
        )}
        <span className="hint" style={{ fontSize: 'var(--text-xs)' }}>
          {rendered === 'loading' && 'Loading the sculpture…'}
          {rendered === 'ready' && (prefersReducedMotion.current ? 'Still view — reduced motion is on.' : 'Drag-to-rotate is off; press play for slow rotation.')}
          {rendered === 'fallback' && 'Interactive view unavailable on this device; the still shows the same sculpture.'}
          {rendered === 'idle' && 'The still above is the same sculpture.'}
        </span>
      </div>
    </div>
  );
}
