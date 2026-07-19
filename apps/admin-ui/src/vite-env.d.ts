/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_ADMIN_DEMO_MODE?: string;
  readonly VITE_CONTROL_PLANE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
