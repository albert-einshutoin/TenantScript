import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { createAdminApiClient } from "./api-client.js";
import "./styles.css";

const root = document.getElementById("root");

if (root === null) {
  throw new Error("root element is missing");
}

createRoot(root).render(
  <StrictMode>
    <App
      client={createAdminApiClient({
        isDevelopment: import.meta.env.DEV,
        demoMode: import.meta.env.VITE_ADMIN_DEMO_MODE === "true",
        controlPlaneUrl: import.meta.env.VITE_CONTROL_PLANE_URL
      })}
    />
  </StrictMode>
);
