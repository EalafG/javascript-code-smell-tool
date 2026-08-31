import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import ValidationApp from "./App";
import "./styles.css";

const root = document.getElementById("validation-root");

if (!root) throw new Error("Validation application root was not found.");

createRoot(root).render(
  <StrictMode>
    <ValidationApp />
  </StrictMode>,
);
