import { createRoot } from "react-dom/client";
import { App } from "./App";
import { ErrorBoundary } from "./ErrorBoundary";
import "./styles.css";
const root = document.getElementById("root");
if (!root) throw new Error("Application root missing");
createRoot(root).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>,
);
