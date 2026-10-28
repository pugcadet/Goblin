import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ConfirmHost } from "./confirm";
import "@fontsource-variable/inter";
import "@fontsource/jetbrains-mono/400.css";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
    <ConfirmHost />
  </React.StrictMode>,
);
