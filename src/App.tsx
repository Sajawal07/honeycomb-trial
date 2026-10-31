import { useEffect, useRef } from 'react';
import { GameEngine } from './game/GameEngine';
import './game/ui/game.css';

/**
 * Thin host component: the game itself is framework-free vanilla TypeScript
 * (Canvas + DOM). React only provides the mount point.
 */
export default function App() {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!host.current) return;
    const engine = new GameEngine(host.current);
    return () => engine.destroy();
  }, []);

  return <div ref={host} style={{ position: 'fixed', inset: 0 }} />;
}
