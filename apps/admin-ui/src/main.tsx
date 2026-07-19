import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { createDemoAdminApiClient, createUnavailableAdminApiClient } from "./api-client.js";
import "./styles.css";

const root = document.getElementById("root");

if (root === null) {
  throw new Error("root element is missing");
}

createRoot(root).render(
  <StrictMode>
    <App
      client={
        import.meta.env.VITE_ADMIN_DEMO_MODE === "true"
          ? createDemoAdminApiClient()
          : createUnavailableAdminApiClient()
      }
    />
  </StrictMode>
);
