import { useEffect, useState } from 'react';
import { healthResponseSchema, type HealthResponse } from '@tsumiwiki/shared';
import { EditorDemo } from './editor/EditorDemo';

export function App() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/health')
      .then((res) => res.json())
      .then((json) => setHealth(healthResponseSchema.parse(json)))
      .catch(() => setError('APIサーバーに接続できません'));
  }, []);

  return (
    <main style={{ fontFamily: 'sans-serif', padding: '2rem' }}>
      <h1>TsumiWiki</h1>
      <p>知識を積む、チームのためのMarkdown Wiki(開発中)</p>
      {health && (
        <p data-testid="health">
          APIサーバー接続OK: {health.name} v{health.version}
        </p>
      )}
      {error && <p data-testid="health-error">{error}</p>}
      <EditorDemo />
    </main>
  );
}
