import { useEffect } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { AppShell } from './components/AppShell';
import { RequireAdmin } from './components/RequireAdmin';
import { RequireAuth } from './components/RequireAuth';
import { EditorDemo } from './editor/EditorDemo';
import { AdminUsersPage } from './pages/AdminUsersPage';
import { LibrarySettingsPage } from './pages/LibrarySettingsPage';
import { LoginPage } from './pages/LoginPage';
import { MainPage } from './pages/MainPage';
import { SettingsPage } from './pages/SettingsPage';
import { TrashPage } from './pages/TrashPage';
import { useThemeStore } from './stores/theme';

// ルーティング定義(設計04章4.1)

export function App() {
  // 初回マウント時にpersist済みのテーマをdata-theme属性へ反映する(デザインhandoff components.md)
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', useThemeStore.getState().theme);
  }, []);

  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<RequireAuth />}>
        <Route element={<AppShell />}>
          <Route index element={<MainPage />} />
          <Route path="doc/*" element={<MainPage />} />
          <Route path="trash" element={<TrashPage />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="demo" element={<EditorDemo />} />
          <Route element={<RequireAdmin />}>
            <Route path="admin/users" element={<AdminUsersPage />} />
            <Route path="admin/library" element={<LibrarySettingsPage />} />
          </Route>
        </Route>
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
