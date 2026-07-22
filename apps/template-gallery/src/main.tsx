import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import rawCatalog from "../../../templates/catalog.json" with { type: "json" };
import { App } from "./App.js";
import type { TemplateCatalog } from "./catalog.js";
import "./styles.css";

const root = document.getElementById("root");

if (root === null) {
  throw new Error("root element is missing");
}

createRoot(root).render(
  <StrictMode>
    <App catalog={rawCatalog as TemplateCatalog} />
  </StrictMode>
);
